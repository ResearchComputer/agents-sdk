# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in `@researchcomputer/agents-sdk`, please report it privately. Do **not** open a public GitHub issue.

Email: `security@research.computer`

We aim to respond within 5 business days and will coordinate a disclosure timeline with you.

## Scope

This repository provides an SDK for LLM-powered coding agents. Please report:

- Sandbox escapes in built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebFetch, NotebookEdit)
- Vulnerabilities in the auth flow (Stytch exchange, token storage, resolver fallback)
- Path traversal, TOCTOU, or symlink-swap races in filesystem tools
- SSRF or credential exfiltration via WebFetch
- Privilege escalation via MCP server configuration
- Insecure defaults in session / memory / telemetry storage

Out of scope: vulnerabilities in underlying runtimes (Node, Bun, wasmtime) — please report those upstream.

## Known Hardening Work in Progress

Documented weaknesses and fix plans live under `docs/plans/`. See `docs/plans/2026-04-24-node-sandbox-hardening.md` for the current sandbox-hardening roadmap.
