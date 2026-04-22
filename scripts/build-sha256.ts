#!/usr/bin/env bun
/**
 * Write the SHA256 of src/python/flash_agents/wasm/core.wasm to
 * CORE_WASM_SHA256.txt alongside it. The Python host verifies this
 * hash at load time (Agent.create) so a stale core.wasm fails fast
 * rather than crashing partway through a turn.
 *
 * Lives under /scripts/ (not /src/python/wasm-guest/) because it uses
 * node:* imports, which the WASM-targeted tsconfig under wasm-guest
 * would reject.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const wasmPath = "src/python/flash_agents/wasm/core.wasm";
const shaPath = "src/python/flash_agents/wasm/CORE_WASM_SHA256.txt";

if (!existsSync(wasmPath)) {
  console.error(`[build-sha256] ${wasmPath} not found — run build:wasm:python:bundle + componentize first`);
  process.exit(1);
}

const hex = createHash("sha256").update(readFileSync(wasmPath)).digest("hex");
writeFileSync(shaPath, hex + "\n");
console.log(`[build-sha256] core.wasm sha256: ${hex}`);
