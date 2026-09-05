/**
 * js-evaluator — host side.
 *
 * Attaches a hidden iframe pointing at the sandbox page and evaluates code inside
 * it, streaming console output, results and errors back over postMessage. The
 * iframe is the isolation boundary: evaluated code never touches this window.
 */

/** The sandbox page published from this repo's GitHub Pages site. */
export const DEFAULT_SANDBOX_SRC =
  "https://sastaachar.github.io/js-evaluator/sandbox/";

const DEFAULT_READY_TIMEOUT = 15000;
const DEFAULT_RUN_TIMEOUT = 30000;
const DEFAULT_SANDBOX_ATTR = "allow-scripts allow-same-origin";
const PING_INTERVAL = 250;

const EVENTS = [
  "ready",
  "start",
  "console",
  "result",
  "error",
  "runtime-error",
  "fetch",
  "end",
  "message",
  "destroy",
];

function randomId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function textOf(args) {
  return args.map((a) => (a && a.value !== undefined ? a.value : "")).join(" ");
}

/**
 * Applies a fetch policy to an intercepted request.
 * `true`/nullish allows, `false` blocks, an array is a hostname allowlist, and a
 * function decides per request (it may be async).
 * @param {boolean|string[]|((req: any) => boolean|Promise<boolean>)|null|undefined} policy
 * @param {object} request
 * @param {string} [base] Base URL for resolving a relative request URL.
 * @returns {Promise<boolean>}
 */
export async function resolveFetchPolicy(policy, request, base) {
  if (policy === undefined || policy === null || policy === true) return true;
  if (policy === false) return false;
  if (Array.isArray(policy)) {
    try {
      return policy.includes(new URL(request.url, base).hostname);
    } catch {
      return false;
    }
  }
  if (typeof policy === "function") return !!(await policy(request));
  return true;
}

/** Thrown for lifecycle problems — never for errors *inside* evaluated code. */
export class EvaluatorError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "EvaluatorError";
    this.code = code;
  }
}

export class SandboxedEval {
  #options;
  #iframe = null;
  #ownsIframe = false;
  #targetOrigin = "*";
  #readyPromise = null;
  #resolveReady = null;
  #rejectReady = null;
  #readyTimer = null;
  #pingTimer = null;
  #isReady = false;
  #destroyed = false;
  #handlers = new Map();
  #activeRun = null;
  #queue = Promise.resolve();
  #pendingImportMap = null;
  #pendingPongs = [];
  #importMapApplied = false;

  /**
   * @param {object} [options]
   * @param {string} [options.src] URL of the sandbox page.
   * @param {Element} [options.container] Where to append the iframe (default `document.body`).
   * @param {boolean} [options.hidden] Keep the iframe out of layout (default `true`).
   * @param {boolean|string[]|((req) => boolean|Promise<boolean>)} [options.fetch]
   *   Policy for `fetch()` calls made by evaluated code: `true` allows all (default),
   *   `false` blocks all, an array is a hostname allowlist, a function decides per request.
   * @param {object} [options.importMap] Import map applied once, before the first run.
   * @param {number} [options.timeout] Per-run timeout in ms (default 30000).
   * @param {number} [options.readyTimeout] Handshake timeout in ms (default 15000).
   * @param {string} [options.sandbox] `sandbox` attribute for the iframe.
   * @param {string} [options.allowedOrigin] Only accept messages from this origin.
   * @param {boolean} [options.narrowOrigin] Tell the sandbox to post back only to us (default `true`).
   */
  constructor(options = {}) {
    this.#options = {
      src: DEFAULT_SANDBOX_SRC,
      container: null,
      hidden: true,
      fetch: true,
      importMap: null,
      timeout: DEFAULT_RUN_TIMEOUT,
      readyTimeout: DEFAULT_READY_TIMEOUT,
      sandbox: DEFAULT_SANDBOX_ATTR,
      allowedOrigin: null,
      narrowOrigin: true,
      ...options,
    };
  }

  get options() {
    return this.#options;
  }

  get iframe() {
    return this.#iframe;
  }

  get isReady() {
    return this.#isReady;
  }

  get isRunning() {
    return this.#activeRun !== null;
  }

  get destroyed() {
    return this.#destroyed;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   * @param {"ready"|"start"|"console"|"result"|"error"|"runtime-error"|"fetch"|"end"|"message"|"destroy"} type
   * @param {(payload: any) => void} handler
   */
  on(type, handler) {
    if (!EVENTS.includes(type)) {
      throw new EvaluatorError(`Unknown event "${type}"`, "UNKNOWN_EVENT");
    }
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    this.#handlers.get(type)?.delete(handler);
  }

  #emit(type, payload) {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        // A listener blowing up must not derail the run it is observing.
        console.error(`[js-evaluator] "${type}" listener threw:`, err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Creates the iframe and resolves once the sandbox has answered the handshake. */
  init() {
    if (this.#destroyed) {
      return Promise.reject(
        new EvaluatorError("This SandboxedEval has been destroyed", "DESTROYED")
      );
    }
    if (this.#readyPromise) return this.#readyPromise;

    if (typeof document === "undefined" || typeof window === "undefined") {
      return Promise.reject(
        new EvaluatorError(
          "SandboxedEval needs a DOM — it cannot run during SSR",
          "NO_DOM"
        )
      );
    }

    this.#readyPromise = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });

    window.addEventListener("message", this.#onMessage);

    const src = this.#buildSrc();
    this.#targetOrigin = this.#originOf(src);

    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", this.#options.sandbox);
    iframe.setAttribute("title", "js-evaluator sandbox");
    if (this.#options.hidden) {
      iframe.style.cssText =
        "position:absolute;width:0;height:0;border:0;visibility:hidden";
    }
    iframe.src = src;

    this.#iframe = iframe;
    this.#ownsIframe = true;
    (this.#options.container || document.body).appendChild(iframe);

    // `ready` is posted the moment the runtime loads. If we somehow miss it — a
    // bfcache restore, a listener attached a tick late — ping until it answers.
    iframe.addEventListener("load", () => {
      if (this.#isReady || this.#destroyed) return;
      this.#pingTimer = setInterval(() => {
        this.#post({ type: "ping" });
      }, PING_INTERVAL);
    });

    this.#readyTimer = setTimeout(() => {
      this.#failReady(
        new EvaluatorError(
          `Sandbox at ${src} did not respond within ${this.#options.readyTimeout}ms`,
          "READY_TIMEOUT"
        )
      );
    }, this.#options.readyTimeout);

    return this.#readyPromise;
  }

  /** Tears down the current sandbox and brings up a fresh one. */
  async reset() {
    if (this.#destroyed) {
      throw new EvaluatorError("This SandboxedEval has been destroyed", "DESTROYED");
    }
    this.#teardown(new EvaluatorError("Sandbox was reset", "RESET"));
    this.#importMapApplied = false;
    return this.init();
  }

  /** Removes the iframe and listeners. The instance cannot be reused afterwards. */
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#teardown(
      new EvaluatorError("SandboxedEval was destroyed", "DESTROYED")
    );
    this.#emit("destroy", null);
    this.#handlers.clear();
  }

  #teardown(reason) {
    clearTimeout(this.#readyTimer);
    clearInterval(this.#pingTimer);
    this.#readyTimer = null;
    this.#pingTimer = null;

    if (this.#activeRun) {
      this.#activeRun.error = {
        name: reason.name,
        message: reason.message,
        stack: reason.stack,
      };
      this.#finishRun(this.#activeRun, "aborted");
    }

    for (const pending of this.#pendingPongs.splice(0)) pending.reject(reason);
    if (this.#pendingImportMap) {
      this.#pendingImportMap.reject(reason);
      this.#pendingImportMap = null;
    }

    if (this.#rejectReady && !this.#isReady) this.#rejectReady(reason);
    this.#resolveReady = null;
    this.#rejectReady = null;
    this.#readyPromise = null;
    this.#isReady = false;

    if (typeof window !== "undefined") {
      window.removeEventListener("message", this.#onMessage);
    }
    if (this.#iframe && this.#ownsIframe) this.#iframe.remove();
    this.#iframe = null;
  }

  #buildSrc() {
    const base = this.#options.src;
    if (!this.#options.narrowOrigin) return base;
    try {
      const url = new URL(base, window.location.href);
      const origin = window.location.origin;
      // An opaque ("null") origin cannot be a postMessage target.
      if (origin && origin !== "null") url.searchParams.set("origin", origin);
      return url.href;
    } catch {
      return base;
    }
  }

  #originOf(src) {
    try {
      const origin = new URL(src, window.location.href).origin;
      return origin && origin !== "null" ? origin : "*";
    } catch {
      return "*";
    }
  }

  #markReady() {
    if (this.#isReady || this.#destroyed) return;
    this.#isReady = true;
    clearTimeout(this.#readyTimer);
    clearInterval(this.#pingTimer);
    this.#readyTimer = null;
    this.#pingTimer = null;
    this.#resolveReady?.(this);
    this.#emit("ready", this);
  }

  #failReady(error) {
    if (this.#isReady) return;
    clearTimeout(this.#readyTimer);
    clearInterval(this.#pingTimer);
    this.#rejectReady?.(error);
    this.#resolveReady = null;
    this.#rejectReady = null;
  }

  #post(message) {
    this.#iframe?.contentWindow?.postMessage(message, this.#targetOrigin);
  }

  // ---------------------------------------------------------------------------
  // Running code
  // ---------------------------------------------------------------------------

  /**
   * Evaluates `code` in the sandbox. Runs are serialised — the sandbox tracks one
   * execution at a time — so overlapping calls queue up.
   *
   * Resolves with a summary rather than rejecting on a script error, because the
   * logs leading up to the failure are usually the point. Check `ok`/`error`.
   *
   * @param {string} code
   * @param {object} [opts]
   * @param {boolean} [opts.module] Force module (`true`) or classic (`false`) mode.
   * @param {"auto"|"signal"} [opts.done] `"signal"` waits for `console.log("[DONE]")`.
   * @param {object} [opts.importMap] Import map to install before this run.
   * @param {number} [opts.timeout] Override the per-run timeout.
   * @param {string} [opts.id] Custom execution id.
   * @returns {Promise<RunResult>}
   */
  run(code, opts = {}) {
    if (typeof code !== "string") {
      return Promise.reject(
        new EvaluatorError("run(code) expects a string", "BAD_CODE")
      );
    }
    const task = () => this.#runNow(code, opts);
    const next = this.#queue.then(task, task);
    // Keep the queue alive regardless of how the previous run ended.
    this.#queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async #runNow(code, opts) {
    if (this.#destroyed) {
      throw new EvaluatorError("This SandboxedEval has been destroyed", "DESTROYED");
    }
    await this.init();

    const importMap = opts.importMap ?? this.#options.importMap;
    if (importMap && !this.#importMapApplied) {
      await this.setImportMap(importMap);
    }

    const id = opts.id || randomId();
    const run = {
      id,
      logs: [],
      runtimeErrors: [],
      result: null,
      error: null,
      startedAt: Date.now(),
      finished: false,
      settle: null,
      timer: null,
    };
    const settled = new Promise((resolve) => {
      run.settle = resolve;
    });
    this.#activeRun = run;

    const message = { type: "execute", code, id, done: opts.done || "auto" };
    if (typeof opts.module === "boolean") message.module = opts.module;
    this.#post(message);

    const timeout = opts.timeout ?? this.#options.timeout;
    if (timeout > 0) {
      run.timer = setTimeout(() => {
        run.error = {
          name: "TimeoutError",
          message: `Execution did not finish within ${timeout}ms`,
          stack: undefined,
        };
        this.#finishRun(run, "timeout");
      }, timeout);
    }

    return settled;
  }

  /** Installs an import map so evaluated modules can use bare specifiers. */
  setImportMap(map) {
    if (!map || typeof map !== "object") {
      return Promise.reject(
        new EvaluatorError("setImportMap(map) expects an object", "BAD_IMPORT_MAP")
      );
    }
    return this.init().then(
      () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.#pendingImportMap = null;
            reject(
              new EvaluatorError("Sandbox never confirmed the import map", "IMPORT_MAP_TIMEOUT")
            );
          }, 5000);
          this.#pendingImportMap = {
            resolve: () => {
              clearTimeout(timer);
              this.#importMapApplied = true;
              resolve();
            },
            reject: (err) => {
              clearTimeout(timer);
              reject(err);
            },
          };
          this.#post({ type: "set-importmap", map });
        })
    );
  }

  /** Round-trips a `ping`. Resolves with the round-trip time in ms. */
  ping(timeout = 5000) {
    return this.init().then(
      () =>
        new Promise((resolve, reject) => {
          const sentAt = Date.now();
          const entry = {
            resolve: () => {
              clearTimeout(timer);
              resolve(Date.now() - sentAt);
            },
            reject,
          };
          const timer = setTimeout(() => {
            this.#pendingPongs = this.#pendingPongs.filter((p) => p !== entry);
            reject(new EvaluatorError("Sandbox did not answer ping", "PING_TIMEOUT"));
          }, timeout);
          this.#pendingPongs.push(entry);
          this.#post({ type: "ping" });
        })
    );
  }

  #finishRun(run, reason) {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(run.timer);
    if (this.#activeRun === run) this.#activeRun = null;

    const endedAt = Date.now();
    const result = {
      id: run.id,
      ok: run.error === null,
      logs: run.logs,
      result: run.result,
      error: run.error,
      runtimeErrors: run.runtimeErrors,
      startedAt: run.startedAt,
      endedAt,
      durationMs: endedAt - run.startedAt,
      timedOut: reason === "timeout",
    };
    this.#emit("end", result);
    run.settle(result);
  }

  // ---------------------------------------------------------------------------
  // Inbound messages
  // ---------------------------------------------------------------------------

  #onMessage = (event) => {
    if (!this.#iframe || event.source !== this.#iframe.contentWindow) return;
    if (this.#options.allowedOrigin && event.origin !== this.#options.allowedOrigin) {
      return;
    }
    const msg = event.data;
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

    this.#emit("message", msg);

    const run =
      this.#activeRun && this.#activeRun.id === msg.executionId
        ? this.#activeRun
        : null;

    switch (msg.type) {
      case "ready":
      case "pong": {
        this.#markReady();
        for (const pending of this.#pendingPongs.splice(0)) pending.resolve();
        break;
      }

      case "execution-start":
        this.#emit("start", { id: msg.executionId, timestamp: msg.timestamp });
        break;

      case "console": {
        const entry = {
          level: msg.level,
          args: msg.args || [],
          text: textOf(msg.args || []),
          timestamp: msg.timestamp,
          executionId: msg.executionId,
        };
        if (run) {
          if (msg.level === "clear") run.logs.length = 0;
          else run.logs.push(entry);
        }
        this.#emit("console", entry);
        break;
      }

      case "execution-result":
        if (run) run.result = msg.result ?? null;
        this.#emit("result", { id: msg.executionId, result: msg.result ?? null });
        break;

      case "execution-error":
        if (run) run.error = msg.error;
        this.#emit("error", { id: msg.executionId, error: msg.error });
        break;

      case "execution-end":
        if (run) this.#finishRun(run, "end");
        break;

      case "runtime-error": {
        if (run) run.runtimeErrors.push(msg.error);
        this.#emit("runtime-error", { id: msg.executionId, error: msg.error });
        break;
      }

      case "fetch-request":
        this.#onFetchRequest(msg);
        break;

      case "importmap-set":
        this.#pendingImportMap?.resolve();
        this.#pendingImportMap = null;
        break;
    }
  };

  async #onFetchRequest(msg) {
    const request = {
      requestId: msg.requestId,
      url: msg.url,
      method: msg.method,
      headers: msg.headers,
      body: msg.body,
      executionId: msg.executionId,
    };

    let allow = false;
    try {
      allow = await this.#decideFetch(request);
    } catch (err) {
      console.error("[js-evaluator] fetch policy threw, blocking request:", err);
      allow = false;
    }

    this.#emit("fetch", { ...request, allowed: allow });
    // Never leave a request hanging — the sandbox's fetch() promise waits on this.
    this.#post({ type: "fetch-response", requestId: msg.requestId, allow });
  }

  #decideFetch(request) {
    const base = this.#targetOrigin === "*" ? undefined : this.#targetOrigin;
    return resolveFetchPolicy(this.#options.fetch, request, base);
  }
}

/**
 * Convenience wrapper: constructs a {@link SandboxedEval} and waits for the
 * handshake, so the instance you get back is ready to `run()`.
 * @param {ConstructorParameters<typeof SandboxedEval>[0]} [options]
 * @returns {Promise<SandboxedEval>}
 */
export async function createEvaluator(options) {
  const evaluator = new SandboxedEval(options);
  await evaluator.init();
  return evaluator;
}

export default SandboxedEval;
