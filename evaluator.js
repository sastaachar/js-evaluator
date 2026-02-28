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

  function execute(code, id) {
    executionId = id || crypto.randomUUID();

    postToHost({
      type: "execution-start",
      executionId,
      timestamp: Date.now(),
    });

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

  window.addEventListener("message", function (event) {
    const { data } = event;
    if (!data || typeof data !== "object") return;

    switch (data.type) {
      case "execute":
        if (typeof data.code === "string") {
          execute(data.code, data.id);
        }
        break;

      case "ping":
        postToHost({ type: "pong", timestamp: Date.now() });
        break;
    }
  });

  window.addEventListener("error", function (event) {
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
    postToHost({
      type: "runtime-error",
      error: {
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
        name: "UnhandledPromiseRejection",
      },
      executionId,
      timestamp: Date.now(),
    });
  });

  postToHost({ type: "ready", timestamp: Date.now() });
})();
