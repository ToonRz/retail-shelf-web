#!/usr/bin/env node
// Pin / fetch / bump the agent release (SPEC §7). Used by the Makefile:
//
//   node scripts/agent-release.mjs fetch                 # make fetch-agent-release (agent.version + agent-shelf.version)
//   node scripts/agent-release.mjs bump [--version vX.Y.Z] [--allow-minor]   # make bump-agent
//   node scripts/agent-release.mjs lag                   # CI: warn when a newer patch exists
//
// Releases come from GitHub (AGENT_REPO, default ToonRz/retail-shelf-agent) or, for tests and
// offline work, from AGENT_RELEASES_DIR: a folder of <vX.Y.Z>/ release folders as written by the
// agent's scripts/package-release.mjs.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const SUPPORTED_CONTRACTS = ["shelf-agent-js/1"]; // = src/agent-contract.ts
export const VERSION_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

export function parseVersion(v) {
  const m = VERSION_RE.exec(v ?? "");
  if (!m) throw new Error(`not a vX.Y.Z version: ${v}`);
  return m.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function readPin(file = "agent.version") {
  const v = readFileSync(file, "utf8").trim();
  if (v !== "mock" && !VERSION_RE.test(v)) throw new Error(`${file} must be "mock" or vX.Y.Z, got "${v}"`);
  return v;
}

// ---------------------------------------------------------------- sources

export function localSource(dir) {
  return {
    name: dir,
    async versions() {
      return readdirSync(dir).filter((v) => VERSION_RE.test(v) && statSync(join(dir, v)).isDirectory());
    },
    async download(version, dest) {
      const src = join(dir, version);
      if (!existsSync(src)) throw new Error(`release ${version} not found in ${dir}`);
      for (const f of readdirSync(src)) copyFileSync(join(src, f), join(dest, f));
    },
  };
}

export function githubSource(repo = process.env.AGENT_REPO ?? "ToonRz/retail-shelf-agent") {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "retail-shelf-web" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const api = async (path) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, { headers });
    if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
    return res.json();
  };
  return {
    name: `github.com/${repo}`,
    async versions() {
      const rels = await api("/releases?per_page=100");
      return rels.filter((r) => !r.draft && !r.prerelease && VERSION_RE.test(r.tag_name)).map((r) => r.tag_name);
    },
    async download(version, dest) {
      const rel = await api(`/releases/tags/${version}`);
      for (const a of rel.assets) {
        const res = await fetch(a.browser_download_url, { headers: { "User-Agent": "retail-shelf-web" } });
        if (!res.ok) throw new Error(`${a.name}: HTTP ${res.status}`);
        writeFileSync(join(dest, a.name), Buffer.from(await res.arrayBuffer()));
      }
    },
  };
}

export const defaultSource = () =>
  process.env.AGENT_RELEASES_DIR ? localSource(process.env.AGENT_RELEASES_DIR) : githubSource();

// ---------------------------------------------------------------- verify + fetch

/** Throws unless `dir` is a complete, untampered release of `version` that this web supports. */
export function verifyRelease(dir, version) {
  const sumsPath = join(dir, "SHA256SUMS");
  if (!existsSync(sumsPath)) throw new Error("SHA256SUMS missing");
  const listed = new Map();
  for (const line of readFileSync(sumsPath, "utf8").split("\n").filter(Boolean)) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error(`SHA256SUMS: bad line "${line}"`);
    listed.set(m[2], m[1]);
  }
  for (const f of readdirSync(dir)) {
    if (f === "SHA256SUMS") continue;
    if (!listed.has(f)) throw new Error(`SHA256SUMS does not list ${f}`);
  }
  for (const [f, want] of listed) {
    if (!existsSync(join(dir, f))) throw new Error(`missing ${f} (listed in SHA256SUMS)`);
    if (sha(join(dir, f)) !== want) throw new Error(`sha256 mismatch: ${f}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    throw new Error("manifest.json missing or not JSON");
  }
  if (manifest.version !== version) throw new Error(`manifest.version is ${manifest.version}, pin is ${version}`);
  if (!SUPPORTED_CONTRACTS.includes(manifest.contract)) {
    throw new Error(`contract ${manifest.contract} not supported (web speaks ${SUPPORTED_CONTRACTS.join(", ")})`);
  }
  for (const [f, want] of Object.entries(manifest.files ?? {})) {
    if (!existsSync(join(dir, f))) throw new Error(`missing ${f} (listed in manifest.files)`);
    if (sha(join(dir, f)) !== want) throw new Error(`manifest.files sha256 mismatch: ${f}`);
  }
  if (!manifest.entry || !(manifest.entry in (manifest.files ?? {}))) throw new Error("manifest.entry not in manifest.files");
  return manifest;
}

/** Download the pinned release into <publicDir>/<version>/ and verify it; delete it on any failure. */
export async function fetchAgentRelease({ version, publicDir = "public/agent", source = defaultSource() }) {
  parseVersion(version);
  const dest = join(publicDir, version);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  try {
    await source.download(version, dest);
    return verifyRelease(dest, version);
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    throw new Error(`fetch-agent-release ${version} from ${source.name}: ${e.message}`);
  }
}

// ---------------------------------------------------------------- bump

/** SPEC §7 rule 1-2: which version to move to. Throws when the move is not allowed. */
export function chooseBump(current, versions, { requested, allowMinor = false } = {}) {
  const valid = versions.filter((v) => VERSION_RE.test(v)).sort(compareVersions);
  if (valid.length === 0) throw new Error("no agent releases found");
  let target;
  if (requested) {
    parseVersion(requested);
    if (!valid.includes(requested)) throw new Error(`release ${requested} does not exist`);
    target = requested;
  } else if (current === "mock") {
    target = valid.at(-1);
  } else {
    const [maj, min] = parseVersion(current);
    const same = valid.filter((v) => { const [a, b] = parseVersion(v); return a === maj && b === min; });
    target = same.at(-1) ?? current;
  }
  if (current !== "mock") {
    if (compareVersions(target, current) < 0) throw new Error(`refusing to go back from ${current} to ${target}`);
    const [a, b] = parseVersion(current), [x, y] = parseVersion(target);
    if ((a !== x || b !== y) && !allowMinor) {
      throw new Error(`${current} -> ${target} changes minor/major: re-run with ALLOW_MINOR=1`);
    }
  }
  return target;
}

const defaultCheck = () => execSync("npm test && npm run build", { stdio: "inherit" });

/** SPEC §7 rule 3-4: fetch + verify -> write agent.version -> check; restore the pin on failure. */
export async function bumpAgent({ versionFile = "agent.version", publicDir = "public/agent", requested, allowMinor = false,
  source = defaultSource(), check = defaultCheck, log = console.log } = {}) {
  const before = readFileSync(versionFile, "utf8");
  const current = readPin(versionFile);
  const target = chooseBump(current, await source.versions(), { requested, allowMinor });
  if (target === current) {
    log(`agent.version is already ${current} (latest patch)`);
    return { from: current, to: current, changed: false };
  }
  try {
    await fetchAgentRelease({ version: target, publicDir, source });
    writeFileSync(versionFile, `${target}\n`);
    check();
  } catch (e) {
    writeFileSync(versionFile, before);
    throw new Error(`bump-agent ${current} -> ${target} failed, agent.version left at ${current}: ${e.message}`);
  }
  log(`agent.version: ${current} -> ${target} (not committed: open a PR)`);
  return { from: current, to: target, changed: true };
}

/** Newer patch of the pinned minor, if any (for a CI warning). */
export async function lag({ versionFile = "agent.version", source = defaultSource() } = {}) {
  const current = readPin(versionFile);
  if (current === "mock") return null;
  const [maj, min] = parseVersion(current);
  const newer = (await source.versions())
    .filter((v) => { const [a, b] = parseVersion(v); return a === maj && b === min && compareVersions(v, current) > 0; })
    .sort(compareVersions);
  return newer.at(-1) ?? null;
}

// ---------------------------------------------------------------- CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { version: { type: "string" }, "allow-minor": { type: "boolean", default: false } },
  });
  const cmd = positionals[0];
  try {
    if (cmd === "fetch") {
      for (const file of ["agent.version", "agent-shelf.version"]) {
        const pin = readPin(file);
        if (pin === "mock") console.log(`${file} is mock: nothing to fetch`);
        else {
          const m = await fetchAgentRelease({ version: pin });
          console.log(`public/agent/${pin}/ ok: ${Object.keys(m.files).length} files, contract ${m.contract}, model ${m.model.name} (${m.model.classes} classes)`);
        }
      }
    } else if (cmd === "bump") {
      await bumpAgent({ requested: values.version || undefined, allowMinor: values["allow-minor"] || process.env.ALLOW_MINOR === "1" });
    } else if (cmd === "lag") {
      const newer = await lag();
      if (newer) console.log(`::warning::agent.version is ${readPin()} but ${newer} is out: run make bump-agent`);
      else console.log("agent.version is on the latest patch");
    } else {
      throw new Error("usage: agent-release.mjs fetch | bump [--version vX.Y.Z] [--allow-minor] | lag");
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
