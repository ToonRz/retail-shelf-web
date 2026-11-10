// C2: fetch-agent-release / bump-agent against fake release folders (same layout and
// manifest / SHA256SUMS format as retail-shelf-agent's scripts/package-release.mjs).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { bumpAgent, chooseBump, fetchAgentRelease, lag, localSource, verifyRelease } from "../scripts/agent-release.mjs";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

function writeRelease(root: string, version: string, opts: { manifestVersion?: string; contract?: string } = {}) {
  const dir = join(root, version);
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {
    "shelf-agent.js": `export const v = "${version}";`,
    "model.onnx": `onnx-${version}`,
    "labels.json": JSON.stringify(["a", "b"]),
    "ort-wasm-simd-threaded.jsep.wasm": "wasm",
  };
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  const manifest = {
    version: opts.manifestVersion ?? version,
    contract: opts.contract ?? "shelf-agent-js/1",
    entry: "shelf-agent.js",
    model: { file: "model.onnx", labels: "labels.json", name: "yolov8n", dataset: "test", classes: 2, imgsz: 640,
      conf: 0.25, iou: 0.7, max_det: 300, sha256: sha(files["model.onnx"]) },
    files: Object.fromEntries(Object.entries(files).sort().map(([f, b]) => [f, sha(b)])),
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const sums = [...Object.keys(files), "manifest.json"].sort().map((f) => `${sha(readFileSync(join(dir, f)))}  ${f}`);
  writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  return dir;
}

/** A web checkout in a temp dir: agent.version + public/agent + a folder of releases. */
function setup(pin: string, versions: string[]) {
  const root = mkdtempSync(join(tmpdir(), "web-"));
  const releases = join(root, "releases");
  for (const v of versions) writeRelease(releases, v);
  const versionFile = join(root, "agent.version");
  writeFileSync(versionFile, `${pin}\n`);
  const publicDir = join(root, "public", "agent");
  const pinned = () => readFileSync(versionFile, "utf8").trim();
  const bump = (o: Record<string, unknown> = {}) =>
    bumpAgent({ versionFile, publicDir, source: localSource(releases), check: () => {}, log: () => {}, ...o });
  return { root, releases, versionFile, publicDir, pinned, bump };
}

describe("chooseBump", () => {
  const all = ["v0.0.1", "v0.0.2", "v0.1.0", "v0.1.1", "v0.1.3", "v0.2.0", "v1.0.0"];
  it("picks the latest patch of the pinned minor, or the latest release from mock", () => {
    expect(chooseBump("v0.1.0", all)).toBe("v0.1.3");
    expect(chooseBump("v0.0.1", all)).toBe("v0.0.2");
    expect(chooseBump("mock", all)).toBe("v1.0.0");
  });
  it("refuses minor/major jumps without allowMinor, and any downgrade", () => {
    expect(() => chooseBump("v0.1.0", all, { requested: "v0.2.0" })).toThrow(/ALLOW_MINOR/);
    expect(() => chooseBump("v0.1.0", all, { requested: "v1.0.0" })).toThrow(/ALLOW_MINOR/);
    expect(chooseBump("v0.1.0", all, { requested: "v0.2.0", allowMinor: true })).toBe("v0.2.0");
    expect(() => chooseBump("v0.1.1", all, { requested: "v0.1.0" })).toThrow(/go back/);
    expect(() => chooseBump("v0.2.0", all, { requested: "v0.1.3", allowMinor: true })).toThrow(/go back/);
    expect(() => chooseBump("v0.1.0", all, { requested: "v0.1.9" })).toThrow(/does not exist/);
  });
});

describe("bump-agent", () => {
  it("bumps a patch: fetches + verifies into public/agent/<v>/ and rewrites agent.version", async () => {
    const w = setup("v0.1.0", ["v0.1.0", "v0.1.1", "v0.2.0"]);
    const r = await w.bump();
    expect(r).toMatchObject({ from: "v0.1.0", to: "v0.1.1", changed: true });
    expect(w.pinned()).toBe("v0.1.1");
    expect(existsSync(join(w.publicDir, "v0.1.1", "shelf-agent.js"))).toBe(true);
  });

  it("refuses to skip a minor unless ALLOW_MINOR, then allows it", async () => {
    const w = setup("v0.1.1", ["v0.1.1", "v0.2.0"]);
    await expect(w.bump({ requested: "v0.2.0" })).rejects.toThrow(/ALLOW_MINOR/);
    expect(w.pinned()).toBe("v0.1.1");
    await w.bump({ requested: "v0.2.0", allowMinor: true });
    expect(w.pinned()).toBe("v0.2.0");
  });

  it("refuses to go back", async () => {
    const w = setup("v0.1.1", ["v0.1.0", "v0.1.1"]);
    await expect(w.bump({ requested: "v0.1.0" })).rejects.toThrow(/go back/);
    expect(w.pinned()).toBe("v0.1.1");
  });

  it("bad SHA256SUMS: refused, folder removed, agent.version unchanged", async () => {
    const w = setup("v0.1.0", ["v0.1.0", "v0.1.1"]);
    writeFileSync(join(w.releases, "v0.1.1", "model.onnx"), "tampered");
    await expect(w.bump()).rejects.toThrow(/sha256 mismatch: model\.onnx/);
    expect(w.pinned()).toBe("v0.1.0");
    expect(existsSync(join(w.publicDir, "v0.1.1"))).toBe(false);
  });

  it("manifest of another version: refused, agent.version unchanged", async () => {
    const w = setup("v0.1.0", ["v0.1.0"]);
    writeRelease(w.releases, "v0.1.1", { manifestVersion: "v0.1.0" });
    await expect(w.bump()).rejects.toThrow(/manifest\.version is v0\.1\.0, pin is v0\.1\.1/);
    expect(w.pinned()).toBe("v0.1.0");
  });

  it("a failing npm test / build restores agent.version", async () => {
    const w = setup("v0.1.0", ["v0.1.0", "v0.1.1"]);
    await expect(w.bump({ check: () => { throw new Error("build failed"); } })).rejects.toThrow(/build failed/);
    expect(w.pinned()).toBe("v0.1.0");
  });

  it("from mock picks the latest release (first real pin)", async () => {
    const w = setup("mock", ["v0.0.1", "v0.1.0"]);
    await w.bump();
    expect(w.pinned()).toBe("v0.1.0");
  });

  it("is a no-op on the latest patch", async () => {
    const w = setup("v0.1.1", ["v0.1.0", "v0.1.1"]);
    expect((await w.bump()).changed).toBe(false);
  });
});

describe("fetch-agent-release / verify", () => {
  it("rejects an unsupported contract, a file missing from manifest.files and an unlisted extra file", async () => {
    const w = setup("v0.1.0", []);
    writeRelease(w.releases, "v0.1.0", { contract: "shelf-agent-js/2" });
    await expect(fetchAgentRelease({ version: "v0.1.0", publicDir: w.publicDir, source: localSource(w.releases) }))
      .rejects.toThrow(/contract shelf-agent-js\/2 not supported/);
    expect(existsSync(join(w.publicDir, "v0.1.0"))).toBe(false);

    const dir = writeRelease(join(w.root, "r2"), "v0.1.0");
    writeFileSync(join(dir, "extra.js"), "x");
    expect(() => verifyRelease(dir, "v0.1.0")).toThrow(/does not list extra\.js/);
  });

  it("lag reports a newer patch of the pinned minor only", async () => {
    const w = setup("v0.1.0", ["v0.1.0", "v0.1.2", "v0.2.0"]);
    expect(await lag({ versionFile: w.versionFile, source: localSource(w.releases) })).toBe("v0.1.2");
    writeFileSync(w.versionFile, "v0.1.2\n");
    expect(await lag({ versionFile: w.versionFile, source: localSource(w.releases) })).toBe(null);
  });
});
