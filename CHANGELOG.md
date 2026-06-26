# Changelog

## Unreleased

- No unreleased changes yet.

## 0.1.1 - 2026-06-26

### Fixed

- The `mcp` npm script now launches the shipped MCP server (`npm run cli -- mcp`) instead of printing a misleading "unavailable in this scaffold" message; the capability always shipped through the CLI entry.

### Changed

- README CLI examples use neutral, company-number-derived output filenames rather than a recognisable company name.

### Added

- `docs/schema-parity.md` documenting this repository's canonical ownership of the company-evidence schema and the byte-pinning rules downstream portfolio repositories follow.

## 0.1.0 - 2026-06-21

First community release of UK Company Dossier.

### Added

- Evidence-linked dossier contract for Companies House public-register data, with source URIs, retrieval timestamps, payload hashes, warnings, and attribution metadata.
- Companies House client and normalisers for company profiles, officers, persons with significant control, charges, insolvency status, filing history, and filing document metadata.
- Safe filing-document retrieval flow with explicit output handling.
- CLI workflows for generating JSON or Markdown dossiers, listing filings, retrieving filing document metadata/files, running diagnostics, and saving/comparing snapshots.
- MCP server tools for agent-driven dossier, filing, document, and snapshot workflows.
- Reproducible random company picker and FTSE 350-style reference examples, with clear non-endorsement and no-bias disclaimers.
- `.env.example`, environment initialisation, live/fixture mode guidance, Companies House API-key setup guidance, and Mermaid-backed README workflows.
- Non-technical and technical use-case documentation to help users explore the repo without needing to reverse-engineer the code.

### Changed

- Established source-available PolyForm Noncommercial licensing, commercial licensing guidance, data licensing notes, third-party notices, and contribution guidance.
- Reframed contribution and commercial-licensing copy to be more community-first while keeping explicit commercial-use permission requirements.
- Strengthened public documentation guardrails around credentials, private information, generated outputs, Companies House attribution, and public example data.

### Fixed

- Hardened cross-platform support for Windows, macOS, and Linux in package smoke tests, npm command execution, snapshot handling, ESM loader paths, and MCP fixture launch.
- Corrected CI security scanning to use the current Gitleaks module path.
- Added and verified release/push gates covering documentation checks, Mermaid checks, formatting, linting, typechecking, tests, build, coverage, secret scanning, and dependency audit.
