#!/usr/bin/env bun
/**
 * Bundle the portable `src/core/` runtime into a single ES module that
 * `jco componentize` can consume. The output is `core.bundle.js` placed
 * under `src/python/flash_agents/wasm/`, which then becomes the input
 * for the componentize step.
 *
 * Notes carried over from the original stub bundler:
 *  - target "browser" is the closest match to esbuild's platform:"neutral".
 *    The core intentionally has no `node:` imports (enforced by
 *    test:lint-core), so no Node built-ins or polyfills sneak in.
 *  - WIT imports like `research-computer:flash-agents/host-llm@0.1.0` are
 *    resolved at componentize time, not bundle time; keep them external so
 *    the import statements survive into the output.
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, '../flash_agents/wasm/core.bundle.js');

const result = await Bun.build({
  entrypoints: [path.join(here, 'entrypoint.ts')],
  target: 'browser',
  format: 'esm',
  external: ['research-computer:*'],
  minify: false,
  sourcemap: 'none',
});

if (!result.success) {
  console.error('[build:wasm:python:bundle] bundling failed:');
  for (const msg of result.logs) console.error(String(msg));
  process.exit(1);
}

if (result.outputs.length !== 1) {
  console.error(
    `[build:wasm:python:bundle] expected exactly one output, got ${result.outputs.length}`,
  );
  process.exit(1);
}

const [output] = result.outputs;
const text = await output.text();
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, text, 'utf-8');
console.log(`[build:wasm:python:bundle] wrote ${outPath} (${text.length} bytes)`);
