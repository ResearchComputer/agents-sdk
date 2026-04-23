# memory.v1

Frontmatter for a memory file. Full file format: YAML frontmatter delimited by `---`, followed by a free-form Markdown body.

## Fields

- `schema_version` — always `"1"` in this version.
- `name` — memory identifier, unique within its containing directory.
- `description` — one-line hook, used by retrieval relevance scoring.
- `type` — `user | feedback | project | reference`.
- `ext` — open namespace bag, see spec §Extensibility.

## Semantics the schema can't enforce

- The Markdown body (everything after the closing `---`) has no schema.
- Filenames on disk are derived from `name` via the sanitization rule in the existing `src/memory/memory.ts`; two memories whose `name` sanitizes to the same filename collide.
