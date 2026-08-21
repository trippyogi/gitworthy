# Reconstructed routing eval

This partition is **not** snapshot-backed frozen eval.

- Cases live in `src/core/routing-eval-cases.ts`.
- Headline accuracy (`mode_top1_accuracy`) uses only `partition: snapshot` cases.
- Reconstructed / research cases never mix into frozen-suite accuracy.
- `false_build_occupied` must stay `0` for definitive-ownership fixtures.
