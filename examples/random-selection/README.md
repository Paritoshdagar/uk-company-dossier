# Random demonstration company selection

This directory defines the public policy used by `npm run examples:select` to produce a reproducible example-company manifest from a predeclared candidate snapshot and seed. The picker ranks each eligible company by `sha256(seed + "\0" + canonicalCompanyNumber)`, sorts by hash and then company number, and selects the declared count from each objective stratum without hand-picking or manual replacement.

If a selected ranked company later fails data retrieval, the candidate snapshot may record a `retrievalFailure`; the manifest retains that failed ranked record and continues down the same stratum ranking until the declared number of non-failed selections is met.

> Demonstration companies were selected programmatically by this repository's documented random-company picker from predeclared Companies House eligibility pools. The author did not choose or rank the selected companies. Inclusion does not imply endorsement, criticism, concern, affiliation, or preference. Public-register information is shown solely to demonstrate software behaviour, may change, and must be verified at Companies House before use.

The initial policy requires one demonstration each from objective Companies House-derived strata: active private company, active public company, and dissolved company. Exclusions are limited to invalid company numbers, missing status, duplicate canonical company numbers, candidates outside the declared strata, and status mismatches.

Future FTSE350 demonstrations use the same deterministic algorithm with seed `ftse350-public-demo-v1` and a dated official FTSE350 constituent snapshot as the eligibility pool; inclusion is not investment, legal, accounting, credit, compliance, or risk commentary.

## Re-run the picker

```bash
npm run examples:select
```

The command is deterministic for a fixed policy, seed, and candidate snapshot. If candidate data changes, commit the policy/snapshot update with the generated manifest and explain the objective source used for the eligibility pool.
