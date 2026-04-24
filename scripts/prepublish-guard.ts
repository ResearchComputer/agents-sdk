#!/usr/bin/env bun
/**
 * Pre-publish safety guard. Runs via `prepublishOnly` before `npm publish`.
 *
 * Checks:
 *  1. No `file:` dependencies in package.json.
 *  2. `dist/` exists and is non-empty.
 *  3. `dist/spec/schemas/` is present (schemas are shipped for loadSchema).
 *  4. `npm pack --dry-run` includes required top-level paths.
 *  5. `dist/` mtime is newer than `src/` (otherwise: stale build).
 *  6. Warns (does not block) if `overrides` is set — overrides do NOT
 *     propagate to downstream consumers. See docs/publishing.md.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
};

// 1. No file: deps
const depsStr = JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies });
if (depsStr.includes('file:')) {
  console.error('ERROR: file: dependencies found — publish the ai-provider fork first');
  process.exit(1);
}

// 2. dist/ exists + populated
if (!existsSync('dist') || readdirSync('dist').length === 0) {
  console.error('ERROR: dist/ is missing or empty — run `bun run build` first');
  process.exit(1);
}

// 3. dist/spec/schemas/ present
if (!existsSync('dist/spec/schemas')) {
  console.error(
    'ERROR: dist/spec/schemas/ missing — the copy-spec step did not run. Run `bun run build`.',
  );
  process.exit(1);
}

// 4. npm pack --dry-run contents
const packOut = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf-8' });
const packJson = JSON.parse(packOut) as Array<{ files: Array<{ path: string }> }>;
const files: string[] = packJson[0].files.map((f) => f.path);
for (const r of ['dist/node/index.js', 'dist/core/index.js', 'docs/spec/schemas']) {
  if (!files.some((f) => f.startsWith(r))) {
    console.error(`ERROR: npm pack output is missing ${r}`);
    process.exit(1);
  }
}

// 5. dist mtime vs src mtime (drift detector)
const distMtime = statSync('dist').mtimeMs;
const srcMtime = statSync('src').mtimeMs;
if (srcMtime > distMtime) {
  console.error('ERROR: src/ is newer than dist/ — rebuild with `bun run build`');
  process.exit(1);
}

// 6. Warn about overrides propagation
if (pkg.overrides && Object.keys(pkg.overrides).length > 0) {
  console.warn('WARN: package.json contains `overrides` which do NOT propagate to downstream');
  console.warn('      consumers. See docs/publishing.md for the current state and mitigation.');
}

console.log('[prepublish-guard] all checks passed');
