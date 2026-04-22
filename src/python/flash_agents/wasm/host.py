"""WASM host facade over the flash_agents_wasm Rust extension.

The Rust extension (src/python/wasm-host) provides flash_agents_wasm.Agent
and flash_agents_wasm.EventStream backed by wasmtime's async Component Model
via pyo3-async-runtimes. Python callers go through this module rather than
importing flash_agents_wasm directly so the extension's low-level surface
can evolve without breaking flash_agents users.
"""

from __future__ import annotations

import hashlib
import pathlib

from flash_agents.errors import WasmHostError


_WASM_DIR = pathlib.Path(__file__).parent
_CORE_WASM = _WASM_DIR / "core.wasm"
_SHA_FILE = _WASM_DIR / "CORE_WASM_SHA256.txt"


def _verify_sha256(wasm_path: pathlib.Path, sha_file: pathlib.Path) -> None:
    """Verify core.wasm matches the SHA written at build time.

    Catches the case where an old wheel ships stale core.wasm (e.g. after
    a TS core change that wasn't re-built before packaging).
    """
    if not wasm_path.exists():
        raise WasmHostError(
            f"core.wasm not found at {wasm_path}. Run `bun run build:wasm:python` "
            f"from the repo root before installing flash-agents from source."
        )
    if not sha_file.exists():
        raise WasmHostError(
            f"CORE_WASM_SHA256.txt not found at {sha_file}. Rebuild core.wasm."
        )
    expected = sha_file.read_text().strip().lower()
    actual = hashlib.sha256(wasm_path.read_bytes()).hexdigest().lower()
    if expected != actual:
        raise WasmHostError(
            f"SHA256 mismatch on core.wasm: expected {expected}, got {actual}. "
            f"Rebuild via `bun run build:wasm:python`."
        )


def wasm_path() -> str:
    """Return the verified core.wasm path. Raises WasmHostError on mismatch."""
    _verify_sha256(_CORE_WASM, _SHA_FILE)
    return str(_CORE_WASM)
