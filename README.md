# JS Evaluator

A lightweight, sandboxed JavaScript execution environment that communicates via `postMessage`. Embed it in an iframe to run arbitrary code and stream console output back to your host page.

## Quick Start

### 1. Embed the evaluator in a sandboxed iframe

```html
<iframe
  id="sandbox"
  sandbox="allow-scripts"
  src="https://your-domain.com/index.html"
  style="display: none;"
></iframe>
```

### 2. Wait for the `ready` event

```js
window.addEventListener("message", (event) => {
  if (event.data.type === "ready") {
    console.log("Evaluator is ready");
  }
});
```

### 3. Send code to execute

```js
const sandbox = document.getElementById("sandbox");

sandbox.contentWindow.postMessage({
  type: "execute",
  code: "console.log('Hello!')",
  id: "optional-execution-id"
}, "*");
```

### 4. Listen for results

```js
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "console":
      console.log(`[${msg.level}]`, msg.args.map(a => a.value).join(" "));
      break;
    case "execution-result":
      console.log("Return value:", msg.result.value);
      break;
    case "execution-error":
      console.error("Error:", msg.error.message);
      break;
  }
});
```

## Inbound Messages (Host → Evaluator)

Messages you send to the evaluator iframe via `postMessage`.

### `execute`

Runs the provided JavaScript code string inside the sandbox.

| Field  | Type     | Required | Description                                                     |
| ------ | -------- | -------- | --------------------------------------------------------------- |
| `type` | `string` | Yes      | Must be `"execute"`.                                            |
| `code` | `string` | Yes      | The JavaScript source code to run.                              |
| `id`   | `string` | No       | A custom execution ID. If omitted, a UUID is generated automatically. |

### `ping`

Health check. The evaluator responds with a `pong` message.

| Field  | Type     | Required | Description     |
| ------ | -------- | -------- | --------------- |
| `type` | `string` | Yes      | Must be `"ping"`. |

## Outbound Messages (Evaluator → Host)

Messages posted back to the host page from the evaluator.

### `ready`

Sent once when the evaluator script has loaded and is listening for messages.

| Field       | Type     | Description           |
| ----------- | -------- | --------------------- |
| `type`      | `string` | `"ready"`             |
| `timestamp` | `number` | `Date.now()` value    |

### `execution-start`

Emitted immediately before the code begins executing.

| Field         | Type     | Description                |
| ------------- | -------- | -------------------------- |
| `type`        | `string` | `"execution-start"`       |
| `executionId` | `string` | ID for this execution run  |
| `timestamp`   | `number` | `Date.now()` value         |

### `console`

Emitted for every `console.log`, `.warn`, `.error`, `.info`, `.debug`, and `.clear` call made by the executed code.

| Field         | Type     | Description                                                             |
| ------------- | -------- | ----------------------------------------------------------------------- |
| `type`        | `string` | `"console"`                                                             |
| `level`       | `string` | One of `log`, `warn`, `error`, `info`, `debug`, `clear`                 |
| `args`        | `array`  | Each argument serialized as `{ type, value }` (see [Serialization](#serialization)) |
| `executionId` | `string` | ID for this execution run                                               |
| `timestamp`   | `number` | `Date.now()` value                                                      |

### `execution-result`

The return value of the executed code. The code runs inside `new Function()`, so you can use `return` statements.

| Field         | Type     | Description                          |
| ------------- | -------- | ------------------------------------ |
| `type`        | `string` | `"execution-result"`                |
| `executionId` | `string` | ID for this execution run            |
| `result`      | `object` | `{ type, value }` of the return value |
| `timestamp`   | `number` | `Date.now()` value                   |

### `execution-error`

Emitted when the code throws a synchronous error.

| Field         | Type     | Description                              |
| ------------- | -------- | ---------------------------------------- |
| `type`        | `string` | `"execution-error"`                     |
| `executionId` | `string` | ID for this execution run                |
| `error`       | `object` | `{ name, message, stack }`               |
| `timestamp`   | `number` | `Date.now()` value                       |

### `execution-end`

Emitted after the code has finished, regardless of success or failure.

| Field         | Type     | Description              |
| ------------- | -------- | ------------------------ |
| `type`        | `string` | `"execution-end"`       |
| `executionId` | `string` | ID for this execution run |
| `timestamp`   | `number` | `Date.now()` value       |

### `runtime-error`

Catches uncaught exceptions and unhandled promise rejections that occur after the initial execution completes (e.g. inside `setTimeout` callbacks or async code).

| Field         | Type     | Description                              |
| ------------- | -------- | ---------------------------------------- |
| `type`        | `string` | `"runtime-error"`                       |
| `executionId` | `string` | ID of the last execution run             |
| `error`       | `object` | `{ name, message, stack }` (stack/name may be absent for global errors) |
| `timestamp`   | `number` | `Date.now()` value                       |

### `pong`

Response to a `ping` message.

| Field       | Type     | Description        |
| ----------- | -------- | ------------------ |
| `type`      | `string` | `"pong"`           |
| `timestamp` | `number` | `Date.now()` value |

## Execution Lifecycle

Every code execution follows this message sequence:

```
Host  →  { type: "execute", code: "..." }

Eval  ←  { type: "execution-start" }
Eval  ←  { type: "console", level: "log", ... }     // 0..N console messages
Eval  ←  { type: "execution-result" }                // or "execution-error"
Eval  ←  { type: "execution-end" }

// Later, from async code:
Eval  ←  { type: "console", ... }                    // async logs
Eval  ←  { type: "runtime-error", ... }              // uncaught async errors
```

## Serialization

All values passed through console methods and return values are serialized into a `{ type, value }` object:

| `type`        | Description                              | `value`                          |
| ------------- | ---------------------------------------- | -------------------------------- |
| `"string"`    | String primitive                         | The string itself                |
| `"number"`    | Number primitive                         | String representation            |
| `"boolean"`   | Boolean primitive                        | `"true"` or `"false"`           |
| `"undefined"` | `undefined`                              | `"undefined"`                    |
| `"null"`      | `null`                                   | `"null"`                         |
| `"object"`    | Object or array                          | `JSON.stringify` output (pretty) |
| `"function"`  | Function                                 | `function.toString()` output     |
| `"error"`     | Error instance                           | `error.message` (plus `stack`)   |

Objects that can't be JSON-serialized (circular references, etc.) fall back to `String(value)`.

## Security

- The evaluator is designed to run inside an iframe with `sandbox="allow-scripts"`. This prevents access to the host page's DOM, cookies, and storage.
- Code is executed via `new Function()`, so it runs in the global scope of the iframe, not the host.
- The evaluator communicates with both `window.parent` (iframe embedding) and `window.opener` (popup windows).
- **For production use**, always specify a target origin instead of `"*"` in your `postMessage` calls, and validate `event.origin` in your message handlers.

## Files

| File           | Purpose                                                              |
| -------------- | -------------------------------------------------------------------- |
| `evaluator.js` | Core evaluator script — intercepts console, listens for postMessage  |
| `index.html`   | Minimal HTML page that loads `evaluator.js` (embed this in an iframe)|
| `demo.html`    | Interactive demo host page with a code editor and output panel       |

## Full Example

```js
const iframe = document.createElement("iframe");
iframe.sandbox = "allow-scripts";
iframe.src = "https://your-domain.com/index.html";
iframe.style.display = "none";
document.body.appendChild(iframe);

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "ready":
      // Evaluator loaded — send code
      iframe.contentWindow.postMessage({
        type: "execute",
        code: `
          for (let i = 1; i <= 5; i++) {
            console.log("Iteration", i);
          }
          return "done";
        `
      }, "*");
      break;

    case "console":
      const text = msg.args.map(a => a.value).join(" ");
      console.log(`[${msg.level}]`, text);
      break;

    case "execution-result":
      console.log("Returned:", msg.result.value);
      break;

    case "execution-error":
      console.error("Error:", msg.error.message);
      break;
  }
});
```

## License

ISC
