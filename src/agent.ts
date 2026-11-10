// The only place the web loads the agent. AGENT_VERSION comes from agent.version at build time.
import type { Agent, Backend, LoadOptions } from "./agent-contract";
import { createMockAgent } from "./mockAgent";

declare const __AGENT_VERSION__: string;
export const AGENT_VERSION: string = __AGENT_VERSION__;

/** Folder the pinned release is served from: <base>agent/<version>/ (staged by `make fetch-agent-release`). */
export function agentBaseUrl(version: string, base: string = import.meta.env.BASE_URL): string {
  return `${base}agent/${version}/`;
}

export async function loadAgent(backend: Backend, onProgress?: LoadOptions["onProgress"]): Promise<Agent> {
  if (AGENT_VERSION === "mock") return createMockAgent(backend);
  const baseUrl = agentBaseUrl(AGENT_VERSION);
  const mod = (await import(/* @vite-ignore */ new URL(`${baseUrl}shelf-agent.js`, location.href).href)) as {
    load(o: LoadOptions): Promise<Agent>;
  };
  return mod.load({ baseUrl, expectedVersion: AGENT_VERSION, backend, onProgress });
}
