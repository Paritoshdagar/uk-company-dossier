# Use case: technical evidence integration

This workflow is for developers and coding agents that need a stable evidence-backed structure for downstream tools.

## Contract-first integration

The public contract is defined by:

- `src/contracts/company-evidence.ts`
- `schemas/company-evidence.schema.json`
- `schemas/VERSION`

Every fact includes an origin and evidence references. Derived facts include a stable `ruleId`.

## CLI integration

Build a JSON dossier and feed it to downstream tooling:

```bash
npm run build
mkdir -p out
npm run cli -- 00445790 --format json --output out/company-dossier.json
```

Validate your downstream parser against `schemas/company-evidence.schema.json`.

## MCP integration

Build the repo:

```bash
npm run build
```

Configure an MCP client using:

- `docs/mcp/claude.json.example`
- `docs/mcp/codex.toml.example`

Useful tools exposed by the MCP server include company search, dossier building, filing listing, filing-document retrieval, snapshot saving, and snapshot comparison.

## Operational notes

- Use fixture mode for CI.
- Use live mode only when a user-owned API key is available.
- Preserve source attribution when storing or redistributing generated output.
- Treat public-register responses as time-sensitive; rerun the dossier before making decisions.
