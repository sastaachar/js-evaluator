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

  function postToHost(message) {
    if (window.parent !== window) {
      window.parent.postMessage(message, "*");
    }
    if (window.opener) {
      window.opener.postMessage(message, "*");
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
  // Override fetch to strip credentials mode (avoids CORS issues with SDKs
  // that hardcode credentials: "include")
  // ---------------------------------------------------------------------------

  const originalFetch = window.fetch.bind(window);
  window.fetch = function (url, opts = {}) {
    const cleaned = Object.assign({}, opts);
    delete cleaned.credentials;
    return originalFetch(url, cleaned);
  };

  // ---------------------------------------------------------------------------
  // Classic execution (new Function) — no import/export support
  // ---------------------------------------------------------------------------

  function execute(code, id) {
    executionId = id || crypto.randomUUID();

    postToHost({
      type: "execution-start",
      executionId,
      timestamp: Date.now(),
    });

    originalConsole.log("[evaluator] classic exec:\n", code);

    try {
      const result = new Function(code)();
      postToHost({
        type: "execution-result",
        executionId,
        result: serialize(result),
        timestamp: Date.now(),
      });
    } catch (err) {
      postToHost({
        type: "execution-error",
        executionId,
        error: {
          message: err.message,
          stack: err.stack,
          name: err.name,
        },
        timestamp: Date.now(),
      });
    }

    postToHost({
      type: "execution-end",
      executionId,
      timestamp: Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // Module execution (<script type="module">) — supports import/export
  // ---------------------------------------------------------------------------

  function executeModule(code, id) {
    executionId = id || crypto.randomUUID();
    const currentExecId = executionId;

    postToHost({
      type: "execution-start",
      executionId: currentExecId,
      timestamp: Date.now(),
    });

    let settled = false;
    const cbName = `__evalCb_${Date.now()}_${Math.random().toString(36).slice(2)}`;

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
      } else {
        postToHost({
          type: "execution-result",
          executionId: currentExecId,
          result: serialize(undefined),
          timestamp: Date.now(),
        });
      }

      postToHost({
        type: "execution-end",
        executionId: currentExecId,
        timestamp: Date.now(),
      });
    }

    pendingModuleSettle = settle;
    window[cbName] = () => settle(null);

    const wrapped = `${code}\nwindow["${cbName}"]?.();\n`;

    originalConsole.log("[evaluator] module exec:\n", wrapped);

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
          const useModule =
            data.module === true ||
            (data.module !== false && hasModuleSyntax(data.code));
          if (useModule) {
            executeModule(data.code, data.id);
          } else {
            execute(data.code, data.id);
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
      pendingModuleSettle(reason instanceof Error ? reason : new Error(String(reason)));
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
