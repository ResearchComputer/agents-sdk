"""SHA256 mismatch detection: altering core.wasm without rebuilding must fail fast."""
from __future__ import annotations

import pathlib

import pytest

from flash_agents.errors import WasmHostError
from flash_agents.wasm import host as host_mod


def test_sha_mismatch_raises(tmp_path: pathlib.Path) -> None:
    fake_wasm = tmp_path / "core.wasm"
    fake_wasm.write_bytes(b"not really a wasm module")
    sha_file = tmp_path / "CORE_WASM_SHA256.txt"
    sha_file.write_text("0" * 64 + "\n")

    with pytest.raises(WasmHostError, match="SHA256 mismatch"):
        host_mod._verify_sha256(fake_wasm, sha_file)


def test_missing_wasm_raises(tmp_path: pathlib.Path) -> None:
    sha_file = tmp_path / "CORE_WASM_SHA256.txt"
    sha_file.write_text("0" * 64 + "\n")
    with pytest.raises(WasmHostError, match="core.wasm not found"):
        host_mod._verify_sha256(tmp_path / "core.wasm", sha_file)


def test_matching_sha_passes(tmp_path: pathlib.Path) -> None:
    import hashlib
    content = b"some bytes"
    fake_wasm = tmp_path / "core.wasm"
    fake_wasm.write_bytes(content)
    sha_file = tmp_path / "CORE_WASM_SHA256.txt"
    sha_file.write_text(hashlib.sha256(content).hexdigest() + "\n")
    host_mod._verify_sha256(fake_wasm, sha_file)  # no raise
