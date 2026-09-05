/**
 * js-evaluator/react — React bindings.
 *
 * Same mechanism as the core class: a hidden iframe is attached on mount and torn
 * down on unmount. The hook adds live React state for the console stream, the last
 * result, and readiness.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { EvaluatorError, SandboxedEval, resolveFetchPolicy } from "./index.js";

/**
 * @typedef {object} UseSandboxedEvalResult
 * @property {boolean} ready         Sandbox has completed its handshake.
 * @property {boolean} running       A run is in flight.
 * @property {Array}   logs          Console entries, newest last.
 * @property {object|null} result    Serialised return value of the last run.
 * @property {object|null} error     Script error from the last run, if any.
 * @property {object|null} lastRun   Full result object of the last run.
 * @property {Error|null} initError  Handshake failure, if the sandbox never came up.
 * @property {(code: string, opts?: object) => Promise<object>} run
 * @property {() => void} clear      Empties `logs`.
 * @property {() => Promise<void>} reset  Replaces the iframe with a fresh sandbox.
 * @property {SandboxedEval|null} evaluator  Escape hatch to the underlying instance.
 */

/**
 * Runs JavaScript inside a sandboxed iframe from a React component.
 *
 * The iframe is recreated only when `src` or `container` change — every other
 * option (including the `fetch` policy) is read live, so a policy that closes over
 * component state stays current without remounting the sandbox.
 *
 * @param {object} [options] Everything {@link SandboxedEval} accepts, plus:
 * @param {boolean} [options.clearOnRun] Empty `logs` when a run starts (default `true`).
 * @param {boolean} [options.enabled] Set `false` to hold off creating the sandbox (default `true`).
 * @returns {UseSandboxedEvalResult}
 */
export function useSandboxedEval(options = {}) {
  const { src, container, enabled = true } = options;

  // Latest options, readable from callbacks that must not be re-created.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const evaluatorRef = useRef(null);
  const [evaluator, setEvaluator] = useState(null);
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [lastRun, setLastRun] = useState(null);
  const [initError, setInitError] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    const instance = new SandboxedEval({
      ...optionsRef.current,
      fetch: (request) =>
        resolveFetchPolicy(optionsRef.current.fetch, request, undefined),
    });

    evaluatorRef.current = instance;
    setEvaluator(instance);
    setReady(false);
    setInitError(null);

    const unsubscribe = [
      instance.on("start", () => {
        if (optionsRef.current.clearOnRun !== false) setLogs([]);
      }),
      instance.on("console", (entry) => {
        setLogs((prev) => (entry.level === "clear" ? [] : [...prev, entry]));
      }),
    ];

    instance.init().then(
      () => {
        if (!cancelled) setReady(true);
      },
      (err) => {
        if (!cancelled) setInitError(err);
      }
    );

    return () => {
      cancelled = true;
      for (const off of unsubscribe) off();
      instance.destroy();
      if (evaluatorRef.current === instance) {
        evaluatorRef.current = null;
        setEvaluator(null);
      }
      setReady(false);
    };
  }, [src, container, enabled]);

  const run = useCallback(async (code, runOptions) => {
    const instance = evaluatorRef.current;
    if (!instance) {
      throw new EvaluatorError(
        "The sandbox is not mounted — check `enabled` and that the component is mounted",
        "NOT_MOUNTED"
      );
    }
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await instance.run(code, runOptions);
      setLastRun(outcome);
      setResult(outcome.result);
      setError(outcome.error);
      return outcome;
    } finally {
      setRunning(false);
    }
  }, []);

  const clear = useCallback(() => setLogs([]), []);

  const reset = useCallback(async () => {
    const instance = evaluatorRef.current;
    if (!instance) return;
    setReady(false);
    setLogs([]);
    setResult(null);
    setError(null);
    setLastRun(null);
    try {
      await instance.reset();
      setReady(true);
    } catch (err) {
      setInitError(err);
    }
  }, []);

  return {
    ready,
    running,
    logs,
    result,
    error,
    lastRun,
    initError,
    run,
    clear,
    reset,
    evaluator,
  };
}

export default useSandboxedEval;
