# Frozen evaluation corpus

Adjudicated offline cases. Each case JSON must include:

- `ground_truth` with a named `failure_mode` and human rationale
- `provider_fixtures` pointing at a `fixture_version: 1` pack under `../fixtures/`

Cases here are **release-blocking**. Expand via GW-024; do not promote private experiments silently.
