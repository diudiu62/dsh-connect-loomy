/**
 * Two build products, one command:
 *
 * - `lib/index.js` — the host half, ESM, Node platform. Every `@deepseek-ai/*`
 *   and `@earendil-works/*` import stays external: the host injects those
 *   modules through the profile, and bundling a second copy would create a
 *   second `LlmRuntime` class identity.
 * - `lib/client.js` — the browser half. The web client's module loader expects
 *   a CJS *factory bundle* wrapped in `window.__ModuleLoader__.load({id, factory})`
 *   (verified against the shipped `@deepseek-ai/dsh-client-ui-*` bundles, e.g.
 *   `dsh-client-ui-settings-web-search/lib/client.js:1-6`). `banner`/`footer`
 *   supply that wrapper; the factory body is the ordinary CJS chunk, and
 *   `require('react')` resolves against the loader's platform seeds.
 *
 * @see docs/dsh-plugin-contract.md §5 and §6
 */
import { defineConfig } from 'tsdown'

/** The id the client module loader registers this bundle under. */
const CLIENT_BUNDLE_ID = 'dsh-connect-desktop'

/**
 * Opening of the loader factory. `module`/`exports` must exist *before* the
 * CJS chunk body runs: rolldown's CJS chunk emits
 * `Object.defineProperty(exports, Symbol.toStringTag, …)` and assigns
 * `exports.apply` itself, so the banner only has to supply the two bindings.
 */
const CLIENT_BANNER = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(CLIENT_BUNDLE_ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
`

/** Closing of the loader factory. The chunk's own code ends above this. */
const CLIENT_FOOTER = `
		return module.exports;
	}
});
`

export default defineConfig([
  {
    name: 'dsh-connect-desktop:host',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    // Emit `lib/index.js` / `lib/index.d.ts`: package.json maps the root
    // export and `types` to exactly those names.
    fixedExtension: false,
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    // `lib/index.d.ts` is the `types` entry of package.json's root export.
    dts: true,
    // Never bundle harness packages: the host owns their single instance.
    deps: {
      neverBundle: [/^@deepseek-ai\//, /^@earendil-works\//],
    },
    clean: false,
  },
  {
    // The CLI is a separate entry rather than a second key on the host config:
    // `bin.js` needs a `#!` banner, and putting that banner on the host config
    // would also prepend it to `lib/index.js`, which the host imports as a
    // module. Same output directory, same externals, no declarations.
    name: 'dsh-connect-desktop:bin',
    entry: { bin: 'src/bin.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    fixedExtension: false,
    outExtensions: () => ({ js: '.js' }),
    dts: false,
    deps: {
      neverBundle: [/^@deepseek-ai\//, /^@earendil-works\//],
    },
    banner: { js: '#!/usr/bin/env node' },
    clean: false,
  },
  {
    name: 'dsh-connect-desktop:client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    dts: false,
    // Emit `lib/client.js`, never `lib/client.cjs`: the `./client` export maps
    // to that exact filename and the loader fetches it by URL.
    fixedExtension: false,
    outExtensions: () => ({ js: '.js' }),
    // `require('@deepseek-ai/dsh-client-ui-slots')` and friends must resolve
    // through the loader's module table, not be inlined.
    deps: {
      neverBundle: [/^@deepseek-ai\//, /^react($|\/)/],
    },
    // CJS normally implies a Node target; this chunk is nonetheless browser
    // CJS (it runs inside the web client's loader), so ask for the browser
    // platform explicitly.
    inputOptions: { platform: 'browser' },
    banner: { js: CLIENT_BANNER },
    footer: { js: CLIENT_FOOTER },
    clean: false,
  },
])
