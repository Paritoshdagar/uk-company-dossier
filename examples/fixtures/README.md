# Fixture examples

Fixture mode is for local development, tests, and documentation checks that must run without a live Companies House API key.

The primary test fixtures live under `tests/fixtures/` and cover:

- Companies House profile, officers, persons with significant control, charges, insolvency, filing history, and document metadata examples;
- public evidence-contract valid and invalid examples;
- random-picker candidate snapshots.

Run fixture-safe checks:

```bash
npm test
npm run docs:links
npm run docs:mermaid
```

Do not place live API responses into fixtures unless they have been deliberately reviewed for privacy, licensing, attribution, freshness, and reproducibility.
