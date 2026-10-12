import { join } from 'node:path';
import esbuild from 'esbuild';

const source = import.meta.dirname;

/** @type {import('esbuild').BuildOptions} */
const mainOptions = {
  bundle: true, platform: 'node', target: 'node22', sourcemap: 'linked',
  supported: { 'dynamic-import': false },
};
/** @type {import('esbuild').BuildOptions} */
const uiOptions = {
  bundle: true, format: 'esm', target: 'chrome140', jsx: 'automatic', sourcemap: 'linked',
  loader: { '.ttf': 'file' },
  define: { 'process.env.NODE_ENV': '"production"' },
  // monaco's export map hides this file, and the entries that re-export it pull in every editor
  // contribution, so the language client is the one import this build resolves by hand.
  alias: { 'monaco-lsp-client': join(source, 'node_modules/monaco-editor/esm/external/monaco-lsp-client/out/index.js') },
};

// The app loads what this writes: main.cjs runs in the main process, ui.js is the renderer entry and
// ui.css sits next to it. Everything the runtime needs is bundled, so the app never needs this repository's
// dependencies and never compiles a plugin itself.
await esbuild.build({ ...mainOptions, absWorkingDir: source, entryPoints: ['main.ts'], outfile: join(source, 'main.cjs') });
await esbuild.build({
  ...uiOptions, absWorkingDir: source, outdir: source,
  entryPoints: ['ui.tsx', 'ui.worker.ts'],
  plugins: [{ name: 'node-sdk-boundary', setup(builder) {
    builder.onResolve({ filter: /^@lengmoxxl\/sdk$/ }, () => ({ errors: [{ text: '@lengmoxxl/sdk is only available in main.ts' }] }));
  } }],
});
