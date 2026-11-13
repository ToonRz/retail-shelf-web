// Copy of the parts of retail-shelf-agent/src/types.ts (contract shelf-agent-js/1) the web uses.
// The web talks to the agent ONLY through this interface. Keep in sync on a contract bump.

export type Backend = "webgpu" | "wasm";

export interface Box {
  cls: string;
  classId: number;
  conf: number;
  xyxy: [number, number, number, number]; // pixels of the original image
}

export interface DetectOptions {
  conf?: number;
  iou?: number;
  maxDet?: number;
  shelfOnly?: boolean; // agent v0.3.2+: run only the 1-class shelf model (older releases ignore it and run both)
}

export interface DetectResult {
  version: string;
  model_sha256: string;
  backend: Backend;
  latency_ms: number;
  width: number;
  height: number;
  boxes: Box[];
}

export type DetectInput = ImageBitmap | ImageData | HTMLImageElement | HTMLCanvasElement;

export interface Agent {
  manifest: { version: string; model: { name: string; classes: number; dataset: string } };
  backend: Backend;
  detect(image: DetectInput, opts?: DetectOptions): Promise<DetectResult>;
  dispose(): Promise<void>;
}

export interface LoadOptions {
  baseUrl: string;
  expectedVersion: string;
  backend?: Backend;
  onProgress?: (loaded: number, total: number | null) => void;
}

/** AgentError.code values a load can fail with (show a clear message for each). */
export type AgentErrorCode =
  | "fetch_failed" | "manifest_invalid" | "version_mismatch" | "contract_mismatch"
  | "model_sha256_mismatch" | "labels_mismatch" | "backend_unavailable" | "not_implemented";
