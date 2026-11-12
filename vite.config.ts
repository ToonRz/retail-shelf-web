import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// The pin. "mock" = use src/mockAgent.ts (no release yet); otherwise vX.Y.Z, served from
// public/agent/<version>/ which `make fetch-agent-release` stages (not committed).
export function readAgentVersion(path = "agent.version"): string {
  const v = readFileSync(path, "utf8").trim();
  if (v !== "mock" && !/^v\d+\.\d+\.\d+$/.test(v)) throw new Error(`${path} must be "mock" or vX.Y.Z, got "${v}"`);
  return v;
}

export default defineConfig({
  // GitHub Pages serves the site at /retail-shelf-web/
  base: process.env.BASE_PATH ?? "/retail-shelf-web/",
  define: {
    __AGENT_VERSION__: JSON.stringify(readAgentVersion()),
    __SHELF_AGENT_VERSION__: JSON.stringify(readAgentVersion("agent-shelf.version")),
  },
});
