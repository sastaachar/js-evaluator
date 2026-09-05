export declare const DEFAULT_SANDBOX_SRC: string;

export type ConsoleLevel =
  | "log"
  | "warn"
  | "error"
  | "info"
  | "debug"
  | "clear";

/**
 * Values crossing the iframe boundary are flattened to a tagged string, since
 * structured clone cannot carry functions, errors or circular objects intact.
 */
export interface SerializedValue {
  type:
    | "string"
    | "number"
    | "boolean"
    | "bigint"
    | "symbol"
    | "undefined"
    | "null"
    | "object"
    | "function"
    | "error";
  value: string;
  /** Present when `type` is `"error"`. */
  stack?: string;
}

export interface LogEntry {
  level: ConsoleLevel;
  args: SerializedValue[];
  /** `args` joined with spaces — what you would have seen in a devtools console. */
  text: string;
  timestamp: number;
  executionId?: string;
}

export interface EvaluatedError {
  name?: string;
  message: string;
  stack?: string;
  /** Set on uncaught window errors rather than thrown exceptions. */
  filename?: string;
  lineno?: number;
  colno?: number;
}

export interface RunResult {
  id: string;
  /** `false` when the script threw, or when the run timed out. */
  ok: boolean;
  logs: LogEntry[];
  /** Return value of classic-mode code. Always `undefined` in module mode. */
  result: SerializedValue | null;
  error: EvaluatedError | null;
  /** Uncaught errors and unhandled rejections seen while this run was open. */
  runtimeErrors: EvaluatedError[];
  startedAt: number;
  endedAt: number;
  durationMs: number;
  timedOut: boolean;
}

export interface FetchRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  executionId?: string;
}

/**
 * `true` allows every request, `false` blocks every request, an array is a
 * hostname allowlist, and a function decides per request.
 */
export type FetchPolicy =
  | boolean
  | string[]
  | ((request: FetchRequest) => boolean | Promise<boolean>);

export interface ImportMap {
  imports?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
  [key: string]: unknown;
}

export interface SandboxedEvalOptions {
  /** URL of the sandbox page. Defaults to {@link DEFAULT_SANDBOX_SRC}. */
  src?: string;
  /** Where to append the iframe. Defaults to `document.body`. */
  container?: Element | null;
  /** Keep the iframe out of layout. Default `true`. */
  hidden?: boolean;
  /** What to do with `fetch()` calls made by evaluated code. Default `true`. */
  fetch?: FetchPolicy;
  /** Import map installed once, before the first run. */
  importMap?: ImportMap | null;
  /** Per-run timeout in ms. Default 30000. `0` disables it. */
  timeout?: number;
  /** Handshake timeout in ms. Default 15000. */
  readyTimeout?: number;
  /** `sandbox` attribute for the iframe. Default `"allow-scripts allow-same-origin"`. */
  sandbox?: string;
  /** Ignore messages that do not come from this origin. */
  allowedOrigin?: string | null;
  /** Ask the sandbox to post back only to this page's origin. Default `true`. */
  narrowOrigin?: boolean;
}

export interface RunOptions {
  /** Force module (`true`) or classic (`false`) mode. Auto-detected when omitted. */
  module?: boolean;
  /** `"signal"` keeps the run open until the code calls `console.log("[DONE]")`. */
  done?: "auto" | "signal";
  /** Import map to install before this run. */
  importMap?: ImportMap;
  /** Override the instance timeout for this run. */
  timeout?: number;
  /** Custom execution id. Generated when omitted. */
  id?: string;
}

export interface EvaluatorEventMap {
  ready: SandboxedEval;
  start: { id: string; timestamp: number };
  console: LogEntry;
  result: { id: string; result: SerializedValue | null };
  error: { id: string; error: EvaluatedError };
  "runtime-error": { id: string; error: EvaluatedError };
  fetch: FetchRequest & { allowed: boolean };
  end: RunResult;
  message: Record<string, unknown> & { type: string };
  destroy: null;
}

export type EvaluatorEvent = keyof EvaluatorEventMap;

export declare class EvaluatorError extends Error {
  name: "EvaluatorError";
  code?: string;
  constructor(message: string, code?: string);
}

export declare function resolveFetchPolicy(
  policy: FetchPolicy | null | undefined,
  request: FetchRequest,
  base?: string
): Promise<boolean>;

export declare class SandboxedEval {
  constructor(options?: SandboxedEvalOptions);

  readonly options: Required<SandboxedEvalOptions>;
  readonly iframe: HTMLIFrameElement | null;
  readonly isReady: boolean;
  readonly isRunning: boolean;
  readonly destroyed: boolean;

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends EvaluatorEvent>(
    type: K,
    handler: (payload: EvaluatorEventMap[K]) => void
  ): () => void;
  off<K extends EvaluatorEvent>(
    type: K,
    handler: (payload: EvaluatorEventMap[K]) => void
  ): void;

  /** Creates the iframe and resolves once the sandbox answers the handshake. */
  init(): Promise<this>;
  /** Replaces the iframe with a fresh sandbox, discarding any state inside it. */
  reset(): Promise<this>;
  /** Removes the iframe and listeners. The instance cannot be reused. */
  destroy(): void;

  /**
   * Evaluates `code` in the sandbox. Resolves with a summary instead of rejecting
   * on a script error — inspect `ok` and `error`. Runs are serialised.
   */
  run(code: string, options?: RunOptions): Promise<RunResult>;
  setImportMap(map: ImportMap): Promise<void>;
  /** Round-trips a ping. Resolves with the round-trip time in ms. */
  ping(timeout?: number): Promise<number>;
}

export declare function createEvaluator(
  options?: SandboxedEvalOptions
): Promise<SandboxedEval>;

export default SandboxedEval;
