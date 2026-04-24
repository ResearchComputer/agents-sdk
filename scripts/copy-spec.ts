#!/usr/bin/env bun
// Copies docs/spec/{schemas,examples} into dist/spec/ so that the in-package
// fast-path in src/node/spec/loader.ts resolves after `npm install`.
import { cpSync, existsSync } from 'node:fs';

for (const dir of ['schemas', 'examples'] as const) {
  const src = `docs/spec/${dir}`;
  const dest = `dist/spec/${dir}`;
  if (existsSync(src)) {
    cpSync(src, dest, { recursive: true });
    console.log(`[copy-spec] ${src} -> ${dest}`);
  } else {
    console.warn(`[copy-spec] source ${src} missing — skipping`);
  }
}
