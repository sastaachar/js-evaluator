# js-evaluator

Run JavaScript inside a sandboxed iframe and stream the console output, return
value and errors back to your page.

The evaluated code lives in a cross-origin iframe, so it cannot touch your DOM,
your globals or your cookies. One class drives it over `postMessage`.

- **ES modules work.** `import` from any ESM CDN, or configure an import map for
  bare specifiers. Top-level `await` included.
- **`fetch()` is interceptable.** Every request the code makes can be approved,
  denied or logged by your page before it goes out.
- **No build step, no dependencies.** Plain ESM plus hand-written types.

[Live demo](https://sastaachar.github.io/js-evaluator/)

## Install

```sh
npm install js-evaluator
```

No dependencies, no peers, no build step.

## Quick start

```js
import { createEvaluator } from "js-evaluator";

const evaluator = await createEvaluator();

const run = await evaluator.run(`
  const nums = [1, 2, 3, 4, 5];
  console.log("Sum:", nums.reduce((a, b) => a + b, 0));
  return nums.length;
`);

run.logs;         // [{ level: "log", text: "Sum: 15", args: [...], timestamp }]
run.result;       // { type: "number", value: "5" }
run.ok;           // true
run.durationMs;   // 4
```

`createEvaluator()` attaches a hidden iframe pointing at the sandbox page hosted
on GitHub Pages and resolves once it has answered the handshake. Use
`new SandboxedEval(...)` plus `await evaluator.init()` if you would rather
construct it eagerly and connect later.

`run()` **resolves rather than rejects when the evaluated code throws** — the
logs leading up to a failure are usually the reason you ran it. Check `ok` and
`error`:

```js
const bad = await evaluator.run("throw new TypeError('boom')");
bad.ok;     // false
bad.error;  // { name: "TypeError", message: "boom", stack: "..." }
```

Only lifecycle problems reject: the sandbox never loading, a bad argument.

## One instance, many runs

An instance owns one iframe and is meant to be reused. `run()` brings the
sandbox up on first call and reuses it on every call after, so there is nothing
to set up and nothing to await beforehand:

```js
const evaluator = new SandboxedEval();

await evaluator.run("globalThis.x = 1");
await evaluator.run("console.log(x)");   // same frame, so x is still there
```

Runs are serialised — the runtime tracks one execution at a time — so
overlapping calls queue rather than interleave:

```js
const [a, b] = await Promise.all([
  evaluator.run("console.log('first')"),
  evaluator.run("console.log('second')"),
]);
```

`cleanup()` removes the iframe and fails anything in flight. It is not terminal:
the next `run()` builds a fresh sandbox, which is also how you throw away state
the evaluated code left behind.

```js
evaluator.cleanup();
await evaluator.run("console.log(typeof x)");   // "undefined" — new frame
```

Call it when you are done — on unmount, on navigation — so the iframe and its
message listener are not left attached.

## Where the sandbox page comes from

By default the iframe points at
`https://sastaachar.github.io/js-evaluator/sandbox/`. That is convenient, and it
means the evaluated code is on an origin that is not yours — but it also means
your playground stops working if GitHub Pages does, and every user's browser
fetches from a third party.

To host it yourself, copy the two files the package ships into whatever your app
serves as static assets:

```sh
cp node_modules/js-evaluator/src/sandbox/* public/sandbox/
```

```js
const evaluator = await createEvaluator({ src: "/sandbox/" });
```

Serving it from a **different origin than your app** is what makes the sandbox
worth having. A subdomain (`sandbox.example.com`) is the usual answer.

## API

### `new SandboxedEval(options)`

| Option         | Type                                       | Default              | Description                                                        |
| -------------- | ------------------------------------------ | -------------------- | ------------------------------------------------------------------ |
| `src`          | `string`                                   | the GitHub Pages URL | Sandbox page to load.                                              |
| `container`    | `Element`                                  | `document.body`      | Where the iframe is appended.                                      |
| `hidden`       | `boolean`                                  | `true`               | Keep the iframe out of layout.                                     |
| `fetch`        | `boolean \| string[] \| function`          | `true`               | Policy for `fetch()` calls made by the code. See below.            |
| `importMap`    | `object`                                   | `null`               | Import map installed once, before the first run.                   |
| `timeout`      | `number`                                   | `30000`              | Per-run timeout in ms. `0` disables it.                            |
| `readyTimeout` | `number`                                   | `15000`              | How long to wait for the handshake.                                |
| `sandbox`      | `string`                                   | `"allow-scripts allow-same-origin"` | `sandbox` attribute for the iframe.               |
| `allowedOrigin`| `string`                                   | `null`               | Ignore messages that do not come from this origin.                 |
| `narrowOrigin` | `boolean`                                  | `true`               | Ask the sandbox to post results only back to your origin.          |

### Methods

| Method                    | Description                                                                    |
| ------------------------- | ------------------------------------------------------------------------------ |
| `init()`                  | Creates the iframe, resolves with the instance once the handshake completes.    |
| `run(code, options?)`     | Evaluates `code`. Resolves with a [`RunResult`](#runresult). Runs are serialised. |
| `setImportMap(map)`       | Installs an import map so modules can use bare specifiers.                      |
| `ping(timeout?)`          | Round-trips a ping; resolves with the round-trip time in ms.                    |
| `cleanup()`               | Removes the iframe and listeners, failing any run in flight. Not terminal.      |

Properties: `isReady`, `isRunning`, `iframe`, `options`.

### `run(code, options)`

| Option      | Type                  | Description                                                      |
| ----------- | --------------------- | ---------------------------------------------------------------- |
| `module`    | `boolean`             | Force module (`true`) or classic (`false`) mode. Auto-detected otherwise. |
| `done`      | `"auto" \| "signal"`  | When the run is considered finished. See [Completion](#completion). |
| `importMap` | `object`              | Import map to install before this run.                            |
| `timeout`   | `number`              | Override the instance timeout.                                    |
| `id`        | `string`              | Custom execution id.                                              |

### RunResult

| Field           | Type                       | Description                                                    |
| --------------- | -------------------------- | -------------------------------------------------------------- |
| `id`            | `string`                   | Execution id.                                                  |
| `ok`            | `boolean`                  | `false` if the code threw or the run timed out.                |
| `logs`          | `LogEntry[]`               | Console output, in order.                                      |
| `result`        | `SerializedValue \| null`  | Return value (classic mode only).                              |
| `error`         | `object \| null`           | `{ name, message, stack }` if the code threw.                  |
| `runtimeErrors` | `object[]`                 | Uncaught errors and unhandled rejections seen while open.      |
| `durationMs`    | `number`                   | Wall-clock duration.                                           |
| `timedOut`      | `boolean`                  | Whether the timeout fired.                                     |

A `LogEntry` is `{ level, args, text, timestamp }`, where `text` is the args
joined with spaces — what you would have seen in a devtools console — and `args`
holds the individually [serialized](#serialization) values.

### Events

`on(type, handler)` returns an unsubscribe function. Use these to stream output
while a run is still in flight; `run()` only resolves at the end.

| Event           | Payload                                  |
| --------------- | ---------------------------------------- |
| `ready`         | the instance                             |
| `start`         | `{ id, timestamp }`                      |
| `console`       | `LogEntry`                               |
| `result`        | `{ id, result }`                         |
| `error`         | `{ id, error }` — the code threw         |
| `runtime-error` | `{ id, error }` — uncaught async error   |
| `fetch`         | the request, plus `allowed`              |
| `end`           | the `RunResult`                          |
| `message`       | every raw message from the sandbox       |
| `cleanup`       | `null`                                   |

```js
const off = evaluator.on("console", (log) => console.log(log.level, log.text));
// …later
off();
```

## Modules and packages

Module syntax is auto-detected, so most code needs no configuration.

```js
await evaluator.run(`
  import confetti from "https://esm.sh/canvas-confetti";
  confetti({ particleCount: 100, spread: 70 });
  console.log("Fired!");
`);
```

For bare specifiers, give the evaluator an import map:

```js
await evaluator.run(
  `import { shuffle } from "lodash-es";
   console.log(shuffle([1, 2, 3, 4, 5]));`,
  {
    importMap: {
      imports: {
        "lodash-es": "https://esm.sh/lodash-es",
        "lodash-es/": "https://esm.sh/lodash-es/",
      },
    },
  }
);
```

Passing a **different** import map to a later run restarts the sandbox, because a
document cannot swap an import map once modules have resolved against it. Passing
the same one repeatedly is free.

### Execution modes

| Mode    | Chosen when                                  | How it runs                | `import`/`export` | `return` value | Top-level `await` |
| ------- | -------------------------------------------- | -------------------------- | ----------------- | -------------- | ----------------- |
| Classic | No module syntax detected, or `module: false` | `new Function(code)()`     | No                | Yes            | No                |
| Module  | `import`/`export` detected, or `module: true` | `<script type="module">`   | Yes               | No             | Yes               |

Detection is a regex over the source with comments and string literals stripped,
and it only matches `import`/`export` at the **start of a line**. A dynamic
`await import(...)` in the middle of a statement will not trip it — pass
`module: true` when you know you need module semantics.

## Completion

`done` controls when a run is considered finished.

**`"auto"`** (default) ends the run as soon as the code's own evaluation
finishes. Async work started by the code keeps running, and its logs still arrive
on the `console` event — but they land after `run()` has already resolved, so they
will not be in `result.logs`.

**`"signal"`** keeps the run open until the code calls `console.log("[DONE]")`.
The marker is swallowed and never appears in the log stream.

```js
const result = await evaluator.run(
  `setTimeout(async () => {
     const r = await fetch("https://example.com/data.json");
     console.log("got", (await r.json()).length, "rows");
     console.log("[DONE]");
   }, 0);`,
  { done: "signal" }
);
result.logs; // includes the async log
```

If the code throws, or a module fails to load, the run ends immediately either
way — `[DONE]` is never coming. If it simply never signals, the run ends when the
timeout fires with `timedOut: true`.

## Intercepting fetch

Every `fetch()` the evaluated code makes is paused and offered to your page
first.

```js
// Allow everything (the default).
createEvaluator({ fetch: true });

// Block everything.
createEvaluator({ fetch: false });

// Hostname allowlist.
createEvaluator({ fetch: ["api.example.com", "jsonplaceholder.typicode.com"] });

// Decide per request; may be async.
createEvaluator({
  fetch: async (req) => {
    console.log(req.method, req.url, req.headers);
    return new URL(req.url).protocol === "https:";
  },
});
```

A blocked request rejects inside the sandbox with
`Fetch blocked by host: <url>`. Requests are never left hanging: if your policy
function throws, the request is denied.

The `credentials` option is stripped from approved requests. Note that this only
covers the options object — a `Request` built with credentials baked in is passed
through as-is, which is one more reason to host the sandbox off your own origin.

## Serialization

Nothing crosses the iframe boundary as a live object. Console arguments and
return values arrive as `{ type, value }`:

| `type`        | `value`                          |
| ------------- | -------------------------------- |
| `"string"`    | the string                       |
| `"number"`    | string representation            |
| `"boolean"`   | `"true"` / `"false"`             |
| `"undefined"` | `"undefined"`                    |
| `"null"`      | `"null"`                         |
| `"object"`    | pretty-printed `JSON.stringify`  |
| `"function"`  | `fn.toString()`                  |
| `"error"`     | `error.message`, plus `stack`    |

Objects that cannot be JSON-serialized (circular references and the like) fall
back to `String(value)`.

## Security

The iframe is the boundary, and it is only as good as the origin you serve the
sandbox page from.

- **Serve the sandbox page from an origin you do not mind the code having.**
  `allow-same-origin` in the iframe's `sandbox` attribute keeps the *sandbox
  page's own* origin (needed for module scripts) — it does not grant access to
  yours. But if you host the sandbox on your app's origin, evaluated code can
  reach your cookies and same-origin APIs.
- **Messages are filtered by `event.source`**, so another frame cannot spoof
  results. Set `allowedOrigin` to also pin the origin.
- **`narrowOrigin`** (on by default) appends `?origin=<your origin>` to the
  sandbox URL, so the runtime posts back only to you instead of `"*"`.
- **This is not a security sandbox against a determined attacker.** It stops
  evaluated code from touching your page. It does not stop that code from
  spinning the CPU, opening popups, or exhausting memory in its own frame.

## The postMessage protocol

You do not need this to use the package — it is here for anyone driving the
sandbox page directly, or porting the host side elsewhere.

Load `sandbox/index.html` in an iframe. It accepts `?origin=<origin>` (post
results only there) and `?debug=1` (echo each snippet into the iframe console).

### Host → sandbox

| Message          | Fields                                            |
| ---------------- | ------------------------------------------------- |
| `execute`        | `code`, `id?`, `module?`, `done?`                 |
| `set-importmap`  | `map`                                             |
| `fetch-response` | `requestId`, `allow`                              |
| `ping`           | —                                                 |

### Sandbox → host

| Message            | Fields                                                        |
| ------------------ | ------------------------------------------------------------- |
| `ready`            | `timestamp` — posted once the runtime is listening            |
| `execution-start`  | `executionId`, `timestamp`                                    |
| `console`          | `level`, `args`, `executionId`, `timestamp`                   |
| `execution-result` | `executionId`, `result`, `timestamp`                          |
| `execution-error`  | `executionId`, `error`, `timestamp`                           |
| `execution-end`    | `executionId`, `timestamp`                                    |
| `runtime-error`    | `executionId`, `error`, `timestamp`                           |
| `fetch-request`    | `requestId`, `url`, `method`, `headers`, `body?`, `executionId` |
| `importmap-set`    | `timestamp`                                                   |
| `pong`             | `timestamp`                                                   |

Every `fetch-request` must be answered with a `fetch-response`, or the `fetch()`
call inside the sandbox hangs forever.

### Lifecycle

```
Host  →  { type: "execute", code: "…" }

Eval  ←  { type: "execution-start" }
Eval  ←  { type: "console", … }            // 0..N
Eval  ←  { type: "execution-result" }      // or execution-error
Eval  ←  { type: "execution-end" }         // deferred until "[DONE]" in signal mode

// afterwards, from async code:
Eval  ←  { type: "console", … }
Eval  ←  { type: "runtime-error", … }
```

## License

ISC
