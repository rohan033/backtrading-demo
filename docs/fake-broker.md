# Fake broker

Use the fake broker to run the live data plane without Angel or eToro credentials.

## CLI

```bash
python -m api.live_server --fake --port 9090 --engine-id local-test
```

## UI

Deploy an execution with `use_fake_client` / fake broker in the control plane UI when supported.

## Package

Implementation: `backtrading.brokers.fake` (shim over `tests/fake_test_client` during migration).

## Smoke

See [ui-smoke.md](ui-smoke.md) — fake deploy row before changing `managers/`.
