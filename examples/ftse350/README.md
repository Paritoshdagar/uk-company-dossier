# FTSE 350 live examples

This directory demonstrates a lightweight live Companies House workflow for large UK-listed public companies without committing raw Companies House payloads.

> Demonstration companies were selected programmatically by this repository's documented random-company picker from predeclared Companies House eligibility pools. The author did not choose or rank the selected companies. Inclusion does not imply endorsement, criticism, concern, affiliation, or preference. Public-register information is shown solely to demonstrate software behaviour, may change, and must be verified at Companies House before use.

## Source and selection

- Candidate source: [London Stock Exchange FTSE 350 constituents table](https://www.londonstockexchange.com/indices/ftse-350/constituents/table).
- Candidate validation: live Companies House company-profile lookups confirmed the predeclared candidates resolved to active PLC records before this example set was generated.
- Random seed: `ftse350-public-demo-v1`.
- Selection algorithm: `sha256(seed + "\0" + canonicalCompanyNumber)`, sorted by hash and company number.

The candidate snapshot is intentionally small and auditable. It is a demonstration pool, not a complete FTSE 350 data product.

## Regenerate

Create `.env` with your own Companies House API key, then run:

```bash
npm run env:init
npm run examples:ftse350
```

If `.env` already exists, edit it instead of recreating it.

## Outputs

- `selection-manifest.json` records the deterministic random selection.
- `live-summary.json` records safe live-summary output from the selected companies.
- `live-summary.md` is the same summary in a non-technical table.

The live summaries include company number, registered name, company status, section availability, profile fact counts, list total counts, and evidence-source counts. They do not include officer names, PSC names, filing rows, addresses, raw payloads, API keys, or Authorization headers.

To generate a full evidence-linked dossier for one selected company, run:

```bash
npm run cli -- 00445790 --format markdown --output out/ftse350-dossier.md
```

## Use safely

These examples are software demonstrations, not legal, accounting, credit, compliance, risk, or investment advice. Public-register data changes. Always verify important facts directly at Companies House before relying on them.
