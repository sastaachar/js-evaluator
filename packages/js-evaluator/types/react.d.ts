import type {
  EvaluatedError,
  LogEntry,
  RunOptions,
  RunResult,
  SandboxedEval,
  SandboxedEvalOptions,
  SerializedValue,
} from "./index.js";

export interface UseSandboxedEvalOptions extends SandboxedEvalOptions {
  /** Empty `logs` when a run starts. Default `true`. */
  clearOnRun?: boolean;
  /** Set `false` to hold off creating the sandbox. Default `true`. */
  enabled?: boolean;
}

export interface UseSandboxedEvalResult {
  /** The sandbox has completed its handshake and can accept code. */
  ready: boolean;
  /** A run is in flight. */
  running: boolean;
  /** Console entries from the current run, newest last. */
  logs: LogEntry[];
  /** Serialised return value of the last run. */
  result: SerializedValue | null;
  /** Script error from the last run, if it threw. */
  error: EvaluatedError | null;
  /** Full result object of the last run. */
  lastRun: RunResult | null;
  /** Set when the sandbox never came up. */
  initError: Error | null;
  run: (code: string, options?: RunOptions) => Promise<RunResult>;
  clear: () => void;
  reset: () => Promise<void>;
  /** Escape hatch to the underlying instance. `null` before mount. */
  evaluator: SandboxedEval | null;
}

/**
 * Runs JavaScript inside a sandboxed iframe from a React component.
 *
 * The iframe is recreated only when `src`, `container` or `enabled` change; every
 * other option is read live, so a `fetch` policy closing over component state stays
 * current without remounting the sandbox.
 */
export declare function useSandboxedEval(
  options?: UseSandboxedEvalOptions
): UseSandboxedEvalResult;

export default useSandboxedEval;
