# Configuration

Tokens are **never** read from config files. Use `GITHUB_TOKEN` or `GH_TOKEN` only.

## Precedence

Highest wins:

1. CLI / MCP input
2. `GITWORTHY_*` environment variables
3. Repository config (`.gitworthy/config.json`)
4. User config (`~/.gitworthy/config.json`)
5. Built-in defaults

Inspect with:

```sh
gitworthy config show --effective --json
gitworthy config validate --json
```

## Files

| Path | Purpose |
|---|---|
| User/repo `config.json` | Defaults for hunt/scan limits, land hints, skill profile pointer |
| Target manifest | Explicit repos/orgs/package mappings for multi-target hunts |
| Skill profile | Advisory languages/topics/ecosystems for ranking |

Schemas (generated, CI-checked):

- `schemas/gitworthy-config.v1.schema.json`
- `schemas/gitworthy-target-manifest.v1.schema.json`
- `schemas/gitworthy-skill-profile.v1.schema.json`

Bootstrap:

```sh
gitworthy init --user
gitworthy init --repo
```

## Skill profile

Affects ranking only — never hard verdict policy. Show resolved profile:

```sh
gitworthy profile show --json
```

Details: [`RANKING.md`](./RANKING.md).

## Environment knobs (common)

| Variable | Role |
|---|---|
| `GITHUB_TOKEN` / `GH_TOKEN` | GitHub API auth |
| `GITWORTHY_CACHE_DIR` | Cache root |
| `GITWORTHY_STORE_DIR` | Local store root |
| `GITWORTHY_MCP_TOKEN` | Bearer for non-loopback HTTP MCP |

## Safety

`config show` redacts unsafe fields. Do not put secrets in manifests or profiles.
