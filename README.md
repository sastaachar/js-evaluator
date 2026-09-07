# js-evaluator

Run JavaScript inside a sandboxed iframe and stream the console output, return
value and errors back to the host page.

This repo holds two things that ship to different places:

| Path                    | What it is                                | Where it goes                                        |
| ----------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `packages/eval-sandbox/` | The npm package — the host-side class      | [npm](https://www.npmjs.com/package/eval-sandbox)     |
| `docs/`                 | The demo site and the sandbox page it loads | [GitHub Pages](https://sastaachar.github.io/js-evaluator/) |

Only the package is published to npm. The site is never packaged.

## Layout

```
packages/eval-sandbox/
  src/index.js          SandboxedEval — attaches the iframe, speaks the protocol
  src/sandbox/          the runtime that lives *inside* the iframe (canonical copy)
  types/                hand-written .d.ts
docs/
  index.html            the demo, driven by the package's own class
  sandbox/              generated copy of src/sandbox — the iframe target
  vendor/               generated copy of src/index.js, so the demo can import it
scripts/sync-site.mjs   copies package → docs
```

`docs/` is named that way because this repo is on GitHub Pages' **legacy** build,
which can only serve from `/` or `/docs` on a branch.

The package is the source of truth for everything under `docs/sandbox/` and
`docs/vendor/`. Those are generated, committed copies — the site has no build
step, so the files have to be sitting there. Edit the originals under
`packages/eval-sandbox/src/`, then:

```sh
npm run sync
```

`npm run check:sync` fails if they have drifted, and runs automatically before
publish.

## Working on it

```sh
npm install       # workspaces; the package itself has no dependencies
npm run site      # sync, then serve docs/ locally
```

Open the served `/` for the demo. The demo loads `./sandbox/`, so it exercises
the same runtime the package ships.

## Publishing

```sh
npm run release   # sync + npm publish -w eval-sandbox
```

The site deploys on its own whenever `docs/` changes on the default branch.

## License

ISC
