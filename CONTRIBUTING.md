# Contributing

Thanks for contributing to `@researchcomputer/agents-sdk`.

## Development Setup

Prerequisites: Bun `>= 1.3.0`, Node `>= 20.0.0`. (Optional: Rust + maturin for Python WASM host development.)

```bash
bun install
bun run lint
bun run test
```

## Submitting Changes

1. Fork the repo and create a feature branch.
2. Make your changes and add tests.
3. Ensure `bun run lint && bun run test` passes. For example scripts, also run `bun run lint:examples`.
4. Open a pull request against `main`.

## Commit Style

Follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): ...`, `fix(scope): ...`, `docs(scope): ...`, `refactor(scope): ...`, `test(scope): ...`.

## Python SDK

The Python SDK lives under `src/python/`. See `src/python/README.md` for setup; it requires Rust + `maturin develop` for the native extension, plus `bun run build:wasm` for the WebAssembly core.

## Architecture Invariants

- `src/core/` is language-agnostic. Non-test files must not import from `node:*`. Enforced by `test:lint-core`.
- Tool input schemas use `@sinclair/typebox`, not raw JSON Schema objects.
- ES modules throughout; strict TypeScript.

See `CLAUDE.md` for a fuller architecture overview.
