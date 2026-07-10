# gitworthy skill

Use gitworthy before spending time on an external repository issue or feature request.

Ordering rule: run contribution policy before investing in any unfamiliar repo. Use `npx gitworthy policy owner/repo --json`, or `npx gitworthy scan owner/repo --json` only as tracker triage and follow its policy reminder when no cached policy exists.

Run the composite check after policy:

```sh
npx gitworthy check owner/repo#123 --json
```

If the project publishes an npm package, include it:

```sh
npx gitworthy check owner/repo#123 --npm-package package-name --json
```

`--npm-package` alone reports package release state; it does not prove an issue-specific fix shipped. For that, add `--probe-glob` and `--probe-contains` so `release_gap` can search the published tarball.

Interpretation:

- ACT means the completed deterministic checks did not find a blocking signal.
- VERIFY means a human must perform the named checks before investing or making any public claim. If `assigned` is present, coordinate before acting. If `no_pr_path` is present, do not plan a PR unless the stated feedback channel says otherwise.
- SKIP means the tool found a strong signal that the work is already handled, in flight, linked to an open PR, released, or duplicated.

Mandatory rule: never make a public claim from a VERIFY verdict without performing the named human checks.

Always read `checked`, `not_checked`, and the evidence URLs. The limitations are part of the result, not footnotes.
