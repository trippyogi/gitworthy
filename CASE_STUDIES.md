# Case studies

Calibration cases that shaped gitworthy v0.3.3. Each entry separates what the tool observed from what a human verified afterward. Hypotheses are labeled as proposals, not facts.

## Case 1 — Dawn cart drawer (Shopify/dawn)

**Situation.** On a Dawn development store, adding more inventory than available returned HTTP 422 from `/cart/add` while the cart drawer stayed empty or stale even though the server cart had partially updated. Tracker issue: [#3921](https://github.com/Shopify/dawn/issues/3921).

**Gitworthy result.** Pre-flight checks did not find a blocking in-flight or duplicate signal for the cart-drawer desync work, so contribution time went into reproducing and fixing the drawer refresh path.

**Human verification.** The 422 partial-add behavior was reproduced on the dev store: server quantity updated, drawer UI did not.

**Outcome.** Opened [#3939](https://github.com/Shopify/dawn/pull/3939) (`Fix cart drawer desync on partial inventory 422`), which refreshes the drawer from the post-422 cart state while keeping the product-page availability warning.

**Product lesson.** Tracker triage alone is not enough; store-reproduced UI/server desync still needs a human check before claiming a fix.

## Case 2 — Buzz duplicate false positive (block/buzz)

**Situation.** Target issue [#1659](https://github.com/block/buzz/issues/1659) asks to preserve classified agent turn failures instead of collapsing them to a transient "Turn error". A linked implementation PR [#1675](https://github.com/block/buzz/pull/1675) reuses the same title phrasing.

**Gitworthy result.** `dupe_cluster` previously treated GitHub `/issues?state=all` rows that were pull requests as duplicate-issue candidates. High lexical overlap with #1675 could emit a blocking `duplicate` signal and push `worth_check` toward SKIP even though the "duplicate" was the fix PR itself.

**Human verification.** Confirmed live: #1659 is the issue; #1675 is the pull request (`pull_request` present on the issues API object).

**Outcome.** v0.3.3 filters PRs out of duplicate clusters and only emits blocking `duplicate` at score ≥ 0.65. Medium-confidence lexical hits may still appear in evidence without forcing SKIP. Regression coverage is in the offline suite.

**Product lesson.** GitHub's issues list includes PRs; duplicate detection must not.

## Case 3 — Firecrawl renamed-repo search (firecrawl/firecrawl)

**Situation.** Issue [#3968](https://github.com/firecrawl/firecrawl/issues/3968) reports a cached PDF scrape returning markdown for a different URL. The repo was renamed from `mendableai/firecrawl` to `firecrawl/firecrawl`. Ordinary REST calls follow redirects; Search `repo:` qualifiers using the old name fail.

**Gitworthy result.** Without canonicalization, Search queries using the input name could 422 or miss linked work after a rename.

**Human verification.** Live `GET /repos/mendableai/firecrawl` currently resolves to `full_name: firecrawl/firecrawl` (confirmed 2026-07-10).

**Outcome.** Posted a source-analysis comment proposing the likely cause is hosted index/cache state ([comment](https://github.com/firecrawl/firecrawl/issues/3968#issuecomment-4927278844)). That comment is a proposal based on OSS code paths and response fields such as `cache_state: hit`; it does not establish that the production bug is definitively that mechanism. v0.3.3 canonicalizes repo names before Search and re-resolves once after a Search 422 on a cached canonical name.

**Product lesson.** Renames break Search qualifiers even when REST still works; never treat a posted hypothesis as a confirmed root cause.

## Case 4 — Release checks vs issue fixes

**Situation.** Package version on `main` can match npm latest while a specific issue fix is still unproven in the published artifact.

**Gitworthy result.** Older `release_gap` behavior could emit `released_fix` from version equality alone (or from a structural sniff of probe evidence).

**Human verification.** Version equality only shows package release state. Issue-specific proof requires a tarball probe that finds the expected string.

**Outcome.** v0.3.3 emits `released_fix` only when versions match, a probe was requested, and `probe.matched === true`. `--npm-package` alone reports release state; use `--probe-glob` + `--probe-contains` for issue-specific artifact evidence.

**Product lesson.** Package state is not issue state.
