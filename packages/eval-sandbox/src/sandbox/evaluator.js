(function () {
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
    clear: console.clear.bind(console),
  };

  let executionId = null;
  let pendingModuleSettle = null;
  let pendingDoneSignal = null;

  // Echoing every snippet into the iframe console is useful while developing the
  // runtime and noise everywhere else. Opt in with ?debug=1 on the sandbox URL.
  const DEBUG = (function () {
    try {
      return new URL(location.href).searchParams.get("debug") === "1";
    } catch {
      return false;
    }
  })();

  function debug(...args) {
    if (DEBUG) originalConsole.log("[evaluator]", ...args);
  }

  function serialize(value) {
    if (value === undefined) return { type: "undefined", value: "undefined" };
    if (value === null) return { type: "null", value: "null" };
    if (typeof value === "function")
      return { type: "function", value: value.toString() };
    if (value instanceof Error)
      return {
        type: "error",
        value: value.message,
        stack: value.stack,
      };
    if (typeof value === "object") {
      try {
        return { type: "object", value: JSON.stringify(value, null, 2) };
      } catch {
        return { type: "object", value: String(value) };
      }
    }
    return { type: typeof value, value: String(value) };
  }

  // The host may narrow where we post by loading this page as
  // `sandbox/index.html?origin=https://its.origin`. Absent that we post to "*",
  // which is safe on its own terms — nothing here is secret — but the host should
  // still check `event.source` before trusting a message.
  const TARGET_ORIGIN = (function () {
    try {
      return new URL(location.href).searchParams.get("origin") || "*";
    } catch {
      return "*";
    }
  })();

  // Fire and forget. The protocol is one-way per message: where the host has to
  // answer (`fetch-request` -> `fetch-response`) it answers with its own
  // postMessage, correlated by id, not over a reply port.
  function postToHost(message) {
    if (window.parent !== window) {
      window.parent.postMessage(message, TARGET_ORIGIN);
    }
    if (window.opener) {
      window.opener.postMessage(message, TARGET_ORIGIN);
    }
  }

  function emitLog(level, args) {
    postToHost({
      type: "console",
      level,
      args: Array.from(args).map(serialize),
      timestamp: Date.now(),
      executionId,
    });
  }

  console.log = function (...args) {
    originalConsole.log(...args);
    if (pendingDoneSignal && args.length === 1 && args[0] === "[DONE]") {
      const signal = pendingDoneSignal;
      pendingDoneSignal = null;
      signal();
      return;
    }
    emitLog("log", args);
  };
  console.warn = function (...args) {
    originalConsole.warn(...args);
    emitLog("warn", args);
  };
  console.error = function (...args) {
    originalConsole.error(...args);
    emitLog("error", args);
  };
  console.info = function (...args) {
    originalConsole.info(...args);
    emitLog("info", args);
  };
  console.debug = function (...args) {
    originalConsole.debug(...args);
    emitLog("debug", args);
  };
  console.clear = function () {
    originalConsole.clear();
    postToHost({
      type: "console",
      level: "clear",
      args: [],
      timestamp: Date.now(),
      executionId,
    });
  };

  // ---------------------------------------------------------------------------
  // Fetch interceptor — requests host approval before executing
  // ---------------------------------------------------------------------------

  const originalFetch = window.fetch.bind(window);
  const pendingFetchApprovals = new Map();

  function serializeHeaders(headers) {
    if (!headers) return {};
    if (headers instanceof Headers) {
      const obj = {};
      headers.forEach((v, k) => {
        obj[k] = v;
      });
      return obj;
    }
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    return headers;
  }

  window.fetch = function (input, opts = {}) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input instanceof Request
        ? input.url
        : String(input);

    const method = (
      opts.method || (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const headers = serializeHeaders(
      opts.headers || (input instanceof Request ? input.headers : undefined)
    );
    const body = opts.body != null ? String(opts.body) : undefined;

    const requestId = crypto.randomUUID();

    postToHost({
      type: "fetch-request",
      requestId,
      url,
      method,
      headers,
      body,
      executionId,
      timestamp: Date.now(),
    });

    return new Promise((resolve, reject) => {
      pendingFetchApprovals.set(requestId, { resolve, reject, input, opts });
    });
  };

  // ---------------------------------------------------------------------------
  // Classic execution (new Function) — no import/export support
  // ---------------------------------------------------------------------------

  function endExecution(execId) {
    postToHost({
      type: "execution-end",
      executionId: execId,
      timestamp: Date.now(),
    });
  }

  /**
   * A run ends once the code has finished AND, in signal mode, once it has logged
   * "[DONE]". Those can arrive in either order — a module that awaits a fetch and
   * then logs "[DONE]" does so *before* its evaluation formally completes — so
   * track both and end on whichever lands last.
   */
  function makeCompletion(execId, waitForSignal) {
    let codeFinished = false;
    let signalled = false;
    let ended = false;

    function maybeEnd() {
      if (ended || !codeFinished) return;
      if (waitForSignal && !signalled) return;
      ended = true;
      pendingDoneSignal = null;
      endExecution(execId);
    }

    return {
      signal() {
        signalled = true;
        maybeEnd();
      },
      finish() {
        codeFinished = true;
        maybeEnd();
      },
      // The code crashed, so "[DONE]" is never coming.
      abort() {
        if (ended) return;
        ended = true;
        pendingDoneSignal = null;
        endExecution(execId);
      },
    };
  }

  function execute(code, id, waitForSignal) {
    executionId = id || crypto.randomUUID();
    const currentExecId = executionId;

    postToHost({
      type: "execution-start",
      executionId: currentExecId,
      timestamp: Date.now(),
    });

    debug("classic exec:\n", code);

    const completion = makeCompletion(currentExecId, waitForSignal);
    // Arm the signal before the code runs, so a synchronous "[DONE]" is caught.
    pendingDoneSignal = waitForSignal ? completion.signal : null;

    try {
      const result = new Function(code)();
      postToHost({
        type: "execution-result",
        executionId: currentExecId,
        result: serialize(result),
        timestamp: Date.now(),
      });
    } catch (err) {
      postToHost({
        type: "execution-error",
        executionId: currentExecId,
        error: { message: err.message, stack: err.stack, name: err.name },
        timestamp: Date.now(),
      });
      completion.abort();
      return;
    }

    completion.finish();
  }

  // ---------------------------------------------------------------------------
  // Module execution (<script type="module">) — supports import/export
  // ---------------------------------------------------------------------------

  function executeModule(code, id, waitForSignal) {
    executionId = id || crypto.randomUUID();
    const currentExecId = executionId;

    postToHost({
      type: "execution-start",
      executionId: currentExecId,
      timestamp: Date.now(),
    });

    let settled = false;
    const cbName = `__evalCb_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;

    const completion = makeCompletion(currentExecId, waitForSignal);
    // A module that awaits and then logs "[DONE]" does so before its evaluation
    // completes, so the signal has to be armed up front.
    pendingDoneSignal = waitForSignal ? completion.signal : null;

    function settle(error) {
      if (settled) return;
      settled = true;
      pendingModuleSettle = null;
      delete window[cbName];

      if (error) {
        postToHost({
          type: "execution-error",
          executionId: currentExecId,
          error: {
            message: error.message || String(error),
            stack: error.stack,
            name: error.name || "Error",
          },
          timestamp: Date.now(),
        });
        completion.abort();
        return;
      }

      postToHost({
        type: "execution-result",
        executionId: currentExecId,
        result: serialize(undefined),
        timestamp: Date.now(),
      });

      completion.finish();
    }

    pendingModuleSettle = settle;
    window[cbName] = () => settle(null);

    const wrapped = `${code}\nwindow["${cbName}"]?.();\n`;

    debug("module exec:\n", wrapped);

    const script = document.createElement("script");
    script.type = "module";
    script.textContent = wrapped;

    script.addEventListener("error", () => {
      settle(new Error("Failed to load module — check import URLs"));
    });

    document.head.appendChild(script);
    setTimeout(() => script.remove(), 100);
  }

  // ---------------------------------------------------------------------------
  // Import map support
  // ---------------------------------------------------------------------------

  let importMapInstalled = false;

  function setImportMap(map) {
    if (importMapInstalled) {
      const old = document.querySelector('script[type="importmap"]');
      if (old) old.remove();
    }
    const script = document.createElement("script");
    script.type = "importmap";
    script.textContent = JSON.stringify(
      typeof map.imports === "object" ? map : { imports: map }
    );
    document.head.appendChild(script);
    importMapInstalled = true;
  }

  // ---------------------------------------------------------------------------
  // Auto-detect module syntax
  // ---------------------------------------------------------------------------

  const MODULE_PATTERN =
    /(^|\n)\s*(import\s+[\w{*]|import\s*\(|import\s+["']|export\s+[\w{*]|export\s+default)/;

  function hasModuleSyntax(code) {
    const stripped = code
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, '""');
    return MODULE_PATTERN.test(stripped);
  }

  // ---------------------------------------------------------------------------
  // Message listener
  // ---------------------------------------------------------------------------

  window.addEventListener("message", function (event) {
    const { data } = event;
    if (!data || typeof data !== "object") return;

    switch (data.type) {
      case "execute":
        if (typeof data.code === "string") {
          const waitForSignal = data.done === "signal";
          const useModule =
            data.module === true ||
            (data.module !== false && hasModuleSyntax(data.code));
          if (useModule) {
            executeModule(data.code, data.id, waitForSignal);
          } else {
            execute(data.code, data.id, waitForSignal);
          }
        }
        break;

      case "fetch-response":
        if (data.requestId && pendingFetchApprovals.has(data.requestId)) {
          const { resolve, reject, input, opts } = pendingFetchApprovals.get(
            data.requestId
          );
          pendingFetchApprovals.delete(data.requestId);
          if (data.allow) {
            const cleaned = Object.assign({}, opts);
            delete cleaned.credentials;
            originalFetch(input, cleaned).then(resolve, reject);
          } else {
            reject(
              new Error(
                "Fetch blocked by host: " +
                  (typeof input === "string" ? input : input.url || input)
              )
            );
          }
        }
        break;

      case "set-importmap":
        if (data.map && typeof data.map === "object") {
          setImportMap(data.map);
          postToHost({ type: "importmap-set", timestamp: Date.now() });
        }
        break;

      case "ping":
        postToHost({ type: "pong", timestamp: Date.now() });
        break;
    }
  });

  // ---------------------------------------------------------------------------
  // Global error handlers
  // ---------------------------------------------------------------------------

  window.addEventListener("error", function (event) {
    if (pendingModuleSettle) {
      pendingModuleSettle(event.error || new Error(event.message));
      return;
    }

    postToHost({
      type: "runtime-error",
      error: {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
      executionId,
      timestamp: Date.now(),
    });
  });

  window.addEventListener("unhandledrejection", function (event) {
    const reason = event.reason;
    const error = {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      name: "UnhandledPromiseRejection",
    };

    if (pendingModuleSettle) {
      pendingModuleSettle(
        reason instanceof Error ? reason : new Error(String(reason))
      );
      return;
    }

    postToHost({
      type: "runtime-error",
      error,
      executionId,
      timestamp: Date.now(),
    });
  });

  postToHost({ type: "ready", timestamp: Date.now() });
})();
