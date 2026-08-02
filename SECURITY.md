# Security Policy

## Supported versions

Security fixes are accepted for the latest published `gitworthy` release on npm. Pre-1.0 releases may receive hardening patches as part of the 1.0 roadmap.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities**, credential leaks, or anything that could help an attacker abuse repository/package inspection paths.

Please report privately via one of:

1. GitHub Security Advisories for [trippyogi/gitworthy](https://github.com/trippyogi/gitworthy/security/advisories/new) (preferred).
2. Email the maintainer listed in `package.json` / GitHub profile if advisory filing is unavailable.

Include:

- Affected version / commit
- Impact and attack scenario
- Minimal reproduction steps or a proof-of-concept fixture (preferred over a live exploit)
- Whether the issue involves local data under `~/.gitworthy`, GitHub API tokens, or inspected third-party repositories/packages

You should receive an acknowledgement within 7 days.

## Trust boundaries (local-first)

Gitworthy is a local-first decision engine. Please treat these as security-sensitive:

- **Tokens** — accepted only via environment / external credential tooling. Never write tokens into config, captures, logs, fixtures, or exports.
- **HTTP MCP** — Streamable HTTP endpoints are hostile-network surfaces. Non-loopback binds require `GITWORTHY_MCP_TOKEN` (Authorization Bearer). Do not expose unauthenticated MCP HTTP. See `docs/HTTP_MCP.md`.
- **Hostile input** — remote repositories, issue text, branch names, API bodies, package metadata, and tarballs are untrusted. Gitworthy must not execute code from a target repository or package.
- **Filesystem / archive inspection** — symlink escape, path traversal, archive bombs, and unbounded clones/downloads are in-scope defect classes.
- **Local outcome store** — corruption, race conditions between CLI and MCP processes, and silent data loss are treated as security/reliability bugs for 1.0.

## Hostile-input security test suite

`test/security/` is the release-facing gate for the defect classes above. It
covers, with offline/mocked fixtures only (no live network):

- **Symlink hostility** — git symlink blobs are never followed for content
  (addressing is always by blob sha, never by tree path); tar symlink/hardlink
  entries are excluded purely by entry type, regardless of their link target.
- **Resource budgets** — per-file and aggregate byte budgets, and entry-count
  budgets, for both git object reads and npm tarball streaming, including
  boundary (cap vs. cap+1) cases and pinned regression checks on the default
  cap values themselves.
- **Binary blobs** — null-byte content is detected and skipped rather than
  returned as garbage text.
- **Path traversal / archive-link hostility** — `..`, absolute posix/Windows/UNC
  paths, and dot-segment tricks are rejected as tarball content sources before
  they are ever read.
- **Timeouts** — git subprocess, HTTP, and tarball-stream timeouts all surface
  typed, stable-coded errors (`npm_tarball_timeout`, `http_timeout`, and typed
  git failure codes) instead of hanging or crashing; a static guard asserts
  every `git` subprocess call site passes an explicit timeout tied to
  `GIT_SUBPROCESS_TIMEOUT_MS`.
- **Invalid CLI/MCP input** — malformed, injection-shaped, and unbounded-length
  inputs are rejected with a stable `category: 'input'` error before any
  network or git call is attempted.

Related coverage also lives in `test/lib/git.test.ts` (GW-012),
`test/lib/registry-tarball.test.ts` (GW-013), and
`test/cli-input-validation.test.ts` / `test/mcp-input-validation.test.ts`
(GW-007).

## Out of scope for public issues

Use private reporting for:

- Token or authorization header leakage
- Ability to read files outside an inspected repository/archive boundary
- Remote code execution via clone, hook, LFS, or package extraction
- Denial-of-service via unbounded network, disk, or CPU consumption in default budgets

Product bugs that do not create a confidentiality, integrity, or availability risk (for example a wrong `VERIFY` disposition) can stay on the public tracker.
