# Publishing Notes

This document captures the operational constraints and known-hazards around publishing `@researchcomputer/agents-sdk` to npm.

## The `overrides` Propagation Problem

`package.json` currently contains an `overrides` block that forces `@mariozechner/pi-ai` (a transitive dependency of `@mariozechner/pi-agent-core`) to resolve to the Research Computer fork `@researchcomputer/ai-provider`.

**`overrides` do not propagate to downstream consumers.** When you run `bun install` in this repository, bun rewrites the transitive graph. When a user runs `npm install @researchcomputer/agents-sdk`, they get the stock transitive dep — which may have diverged from the fork.

### Current state

- In-repo: `@mariozechner/pi-ai` is replaced by `@researchcomputer/ai-provider@^0.1.0` via `overrides`.
- Downstream consumers: get `@mariozechner/pi-ai` at whatever version `@mariozechner/pi-agent-core` pins.
- CI tests against the overridden tree. Consumers run against a different tree.

### Near-term mitigation

Add `@researchcomputer/ai-provider` as a direct dependency (not `overrides`-only) at a version known to be compatible with the `pi-ai` interface that `pi-agent-core` expects. Document in the getting-started guide that consumers should install it directly.

### Long-term plan

Replace or fork `pi-agent-core` under the `@researchcomputer` namespace so the entire dependency tree is first-party. Once that lands, remove the `overrides` hack.

## Pre-publish Guard

`npm publish` automatically runs `prepublishOnly`, which executes `scripts/prepublish-guard.ts`. The guard checks:

1. No `file:` dependencies in `package.json`.
2. `dist/` exists and is non-empty.
3. `dist/spec/schemas/` is present (schemas are required at runtime for `loadSchema`).
4. `npm pack --dry-run` includes `dist/node/index.js`, `dist/core/index.js`, and `docs/spec/schemas/**`.
5. `dist/` is newer than `src/` (otherwise the build is stale).
6. Warns (does not block) if `overrides` is non-empty.

If any check fails, the publish is aborted.

## Shipped Files

`package.json` `files`:

```json
"files": [
  "dist",
  "!dist/**/*.test.*",
  "docs/spec/schemas",
  "docs/spec/examples",
  "LICENSE"
]
```

`docs/spec/schemas` is required because `src/node/spec/loader.ts`'s `loadSchema` reads JSON schemas from disk. The `dist/spec/` fast-path (populated by `scripts/copy-spec.ts`) is preferred at runtime, but the `docs/spec/schemas` tree is shipped as a fallback for any consumer bundling differently.

## Python Wheel Publishing

The Python SDK lives under `src/python/` and publishes independently. See `.github/workflows/publish.yml` and `src/python/README.md`.
