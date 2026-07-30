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
- **Hostile input** — remote repositories, issue text, branch names, API bodies, package metadata, and tarballs are untrusted. Gitworthy must not execute code from a target repository or package.
- **Filesystem / archive inspection** — symlink escape, path traversal, archive bombs, and unbounded clones/downloads are in-scope defect classes.
- **Local outcome store** — corruption, race conditions between CLI and MCP processes, and silent data loss are treated as security/reliability bugs for 1.0.

## Out of scope for public issues

Use private reporting for:

- Token or authorization header leakage
- Ability to read files outside an inspected repository/archive boundary
- Remote code execution via clone, hook, LFS, or package extraction
- Denial-of-service via unbounded network, disk, or CPU consumption in default budgets

Product bugs that do not create a confidentiality, integrity, or availability risk (for example a wrong `VERIFY` disposition) can stay on the public tracker.
