# gitworthy skill

Use gitworthy before spending time on an external repository issue or feature request.

Run the composite check first:

```sh
npx gitworthy check owner/repo#123 --json
```

If the project publishes an npm package, include it:

```sh
npx gitworthy check owner/repo#123 --npm-package package-name --json
```

Interpretation:

- ACT means the completed deterministic checks did not find a blocking signal.
- VERIFY means a human must perform the named checks before investing or making any public claim.
- SKIP means the tool found a strong signal that the work is already handled, in flight, released, or duplicated.

Mandatory rule: never make a public claim from a VERIFY verdict without performing the named human checks.

Always read `checked`, `not_checked`, and the evidence URLs. The limitations are part of the result, not footnotes.
