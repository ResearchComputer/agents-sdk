# Changelog

All notable changes to this project will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `redactMessages` adapter hook (`AgentConfig.redactMessages` / `CoreAdapters.redactMessages`) scrubs `AgentMessage` arrays before they are written to `llm_api_call.request_messages` / `agent_message.content` trajectory events and before upload.
- `createContentRedactor` opt-in helper covering AWS key IDs, OpenAI-style `sk-` keys, and JWT-shaped tokens.
- `docs/plans/2026-04-24-*.md` implementation plans for telemetry privacy, repo/docs repair, core concurrency, node sandbox hardening, Python SDK fixes, and test/CI hardening.
- `examples/tsconfig.json` + `lint:examples` script so example scripts are type-checked.
- `scripts/copy-spec.ts` copies `docs/spec/{schemas,examples}` into `dist/spec/` at build time.
- `scripts/prepublish-guard.ts` validates `dist/`, schema shipping, and tarball contents before publish.
- `LICENSE`, `SECURITY.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `docs/publishing.md`.

### Fixed
- `llm_api_call.request_messages` now captures the per-turn input at `message_start` rather than the cumulative `agent.state.messages` at `message_end`. This prevents O(n²) growth on long sessions and keeps the assistant's own reply out of its own request record.
- `uploader.ts` now honors the `captureTrajectory` flag — previously the flag was plumbed through types end-to-end but never read, so every session uploaded its trajectory regardless of user intent.
- `src/node/spec/loader.ts` gained an in-package fast-path so `loadSchema` resolves from `dist/spec/schemas/` after `npm install`. Previously the walker only looked for the repo-local `docs/spec/`.
- 5 example scripts that imported `../src/index.js` (which does not exist) now import `../src/node/index.js`.

### Changed
- `package.json` `files` now ships `docs/spec/schemas`, `docs/spec/examples`, and `LICENSE`. `build` now runs `scripts/copy-spec.ts`. `prepublishOnly` now runs the full guard script.
- Added `build:wasm` alias to `package.json` scripts (delegates to `build:wasm:python`).

### Tests
- Replaced tautological tests in `src/node/factory-redact.test.ts`. New tests drive real tool calls through a mocked `streamFn`, parse the trajectory JSONL on disk, and assert redaction applies end-to-end.
- Added unit tests for `createContentRedactor` covering all three default patterns + extraPatterns.
- Added `uploader.test.ts` coverage for the `captureTrajectory` stripping behavior.

## [0.2.0]

Initial public release.
