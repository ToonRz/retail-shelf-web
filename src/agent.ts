// The only place the web loads the agent. AGENT_VERSION comes from agent.version at build time.
import type { Agent, Backend, LoadOptions } from "./agent-contract";
import { createMockAgent } from "./mockAgent";

declare const __AGENT_VERSION__: string;
declare const __SHELF_AGENT_VERSION__: string;
export const AGENT_VERSION: string = __AGENT_VERSION__;
export const SHELF_AGENT_VERSION: string = __SHELF_AGENT_VERSION__; // release used by the shelf watch page (agent-shelf.version)

/** Folder the pinned release is served from: <base>agent/<version>/ (staged by `make fetch-agent-release`). */
export function agentBaseUrl(version: string, base: string = import.meta.env.BASE_URL): string {
  return `${base}agent/${version}/`;
}

const queues = new Map<string, Promise<unknown>>();

/** Runs fn after every earlier call with the same key has settled (resolved or rejected). */
export function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, run.catch(() => undefined));
  return run;
}

// Both pages pin the same release, and on #watch both load at once. Chromium fails one of two
// parallel downloads of the same large file (net::ERR_CACHE_WRITE_FAILURE), so loads of one version
// take turns: the second reads the .onnx files from the HTTP cache. Each page keeps its own Agent,
// so a backend switch (dispose) on one page does not touch the other.
export function loadAgent(backend: Backend, onProgress?: LoadOptions["onProgress"], version: string = AGENT_VERSION): Promise<Agent> {
  if (version === "mock") return Promise.resolve(createMockAgent(backend));
  return oneAtATime(version, () => loadRelease(backend, onProgress, version));
}

async function loadRelease(backend: Backend, onProgress: LoadOptions["onProgress"], version: string): Promise<Agent> {
  const baseUrl = agentBaseUrl(version);
  const mod = (await import(/* @vite-ignore */ new URL(`${baseUrl}shelf-agent.js`, location.href).href)) as {
    load(o: LoadOptions): Promise<Agent>;
  };
  return mod.load({ baseUrl, expectedVersion: version, backend, onProgress });
}
