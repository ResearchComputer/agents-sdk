#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const version = process.argv[2];
if (!version || !/^[0-9]+(?:\.[0-9]+){1,2}(?:(?:a|b|rc)[0-9]+)?(?:\.post[0-9]+)?(?:\.dev[0-9]+)?$/.test(version)) {
  console.error('Usage: node scripts/bump-python-version.mjs <version>');
  console.error('Example: node scripts/bump-python-version.mjs 0.2.0');
  process.exit(2);
}

const replacements = [
  {
    path: 'src/python/pyproject.toml',
    rules: [
      [/^version = ".*"$/m, `version = "${version}"`],
      [/flash-agents-wasm==[^"]+/m, `flash-agents-wasm==${version}`],
    ],
  },
  {
    path: 'src/python/wasm-host/pyproject.toml',
    rules: [[/^version = ".*"$/m, `version = "${version}"`]],
  },
  {
    path: 'src/python/wasm-host/Cargo.toml',
    rules: [[/^version = ".*"$/m, `version = "${version}"`]],
  },
  {
    path: 'src/python/flash_agents/__init__.py',
    rules: [[/^__version__ = ".*"$/m, `__version__ = "${version}"`]],
  },
  {
    path: 'src/python/wasm-host/src/lib.rs',
    rules: [[/m\.add\("__version__", ".*"\)\?;/m, `m.add("__version__", "${version}")?;`]],
  },
  {
    path: 'src/python/wit/world.wit',
    rules: [[/^package research-computer:flash-agents@.*;$/m, `package research-computer:flash-agents@${version};`]],
  },
  {
    path: 'src/python/wasm-guest/entrypoint.ts',
    rules: [[/research-computer:flash-agents\/host-llm@[^"]+/g, `research-computer:flash-agents/host-llm@${version}`]],
  },
  {
    path: 'src/python/wasm-guest/adapters.ts',
    rules: [[/research-computer:flash-agents\/host-tools@[^"]+/g, `research-computer:flash-agents/host-tools@${version}`]],
  },
  {
    path: 'src/python/wasm-guest/wit-imports.d.ts',
    rules: [
      [/research-computer:flash-agents\/host-llm@[^"]+/g, `research-computer:flash-agents/host-llm@${version}`],
      [/research-computer:flash-agents\/host-tools@[^"]+/g, `research-computer:flash-agents/host-tools@${version}`],
    ],
  },
];

for (const item of replacements) {
  let text = readFileSync(item.path, 'utf8');
  for (const [pattern, replacement] of item.rules) {
    if (!pattern.test(text)) {
      console.error(`Pattern ${pattern} did not match ${item.path}`);
      process.exit(1);
    }
    text = text.replace(pattern, replacement);
  }
  writeFileSync(item.path, text);
}

execFileSync('cargo', ['update', '--manifest-path', 'src/python/wasm-host/Cargo.toml', '-p', 'rc_agents_wasm'], {
  stdio: 'inherit',
});

console.log(`Bumped Python package versions to ${version}`);
