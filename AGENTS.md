# Agent instructions

This repository is intended to become public. Protect the maintainer's privacy, protect credentials, and keep all public artifacts reproducible.

## Repo map

- `src/companies-house/` contains the HTTP client, endpoint wrappers, normalisers, and document retrieval helpers.
- `src/contracts/` contains the public evidence contract and error redaction utilities.
- `src/app/` composes endpoint results into a company dossier.
- `src/renderers/` renders JSON and Markdown output.
- `src/snapshots/` stores and compares local dossier snapshots.
- `src/cli/` exposes the command-line interface.
- `src/mcp/` exposes the MCP tool surface for agents.
- `src/doctor/` checks fixture and live readiness.
- `src/examples/` contains reproducible example-selection logic.
- `schemas/` contains the public JSON Schema contract.
- `tests/` contains unit, contract, CLI, MCP, and fixture tests.
- `docs/` and `examples/` contain public-facing guidance.

## Architecture boundaries

- Keep Companies House transport concerns in `src/companies-house/`.
- Keep dossier composition in `src/app/`; do not make renderers or CLI commands invent facts.
- Keep public contract changes in `src/contracts/` and `schemas/`.
- Keep filesystem write safety in the specific feature that writes files.
- Keep credential handling inside environment/client boundaries and redact errors before user-visible output.
- Public contract changes must update tests, docs, schemas, and fixtures together.

## Official-source policy

Use official Companies House documentation for API behaviour:

- Developer Hub: https://developer.company-information.service.gov.uk/
- Get started: https://developer.company-information.service.gov.uk/get-started
- Application/API key creation: https://developer.company-information.service.gov.uk/how-to-create-an-application
- Authentication: https://developer.company-information.service.gov.uk/authentication
- Developer guidelines: https://developer.company-information.service.gov.uk/developer-guidelines
- API testing: https://developer.company-information.service.gov.uk/api-testing
- API specifications: https://developer-specs.company-information.service.gov.uk/
- Public Data API reference: https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/reference
- Document API reference: https://developer-specs.company-information.service.gov.uk/document-api/reference
- Data products: https://www.gov.uk/guidance/companies-house-data-products

When docs or code cite API semantics, link to the official source used.

## Local setup

```bash
npm install
npm run build
cp .env.example .env
```

Users must create their own Companies House API key, add it to `.env`, and never commit `.env`.

## Fixture and live readiness

Fixture-ready checks should run without a live key:

```bash
npm run doctor
npm test
```

Live-ready checks require a user-owned key in the local environment:

```bash
npm run cli -- doctor --live
```

Do not print, hash, partially reveal, or commit live credentials.

## TDD loop

For behavioural changes:

1. Add or update the failing test first.
2. Run the focused test and confirm the expected failure.
3. Implement the smallest change.
4. Re-run the focused test.
5. Run the wider verification commands before commit.

For docs-only changes, add deterministic docs checks where practical.

## Code discovery

Prefer codebase-memory-mcp graph tools before text search:

1. `search_graph` for functions, classes, routes, variables, and symbols.
2. `trace_path` for callers/callees.
3. `get_code_snippet` for exact source.
4. `query_graph` for complex patterns.
5. `get_architecture` for high-level structure.

Fallback to `rg` for string literals, docs, config, shell scripts, or when graph tools are unavailable.

## Schema-change process

If the evidence contract changes:

1. Update TypeScript contract definitions.
2. Update `schemas/company-evidence.schema.json`.
3. Update valid and invalid fixtures.
4. Update renderers if output shape changes.
5. Update CLI/MCP docs and examples.
6. Run contract tests and full release verification.

## CLI and MCP smokes

After build:

```bash
npm run cli -- --help
npm run cli -- doctor
npm run cli -- doctor --live
mkdir -p out
npm run cli -- 00445790 --format json --output out/example-dossier.json
npx vitest run tests/mcp/tools.test.ts
```

The MCP server is a long-running stdio service. Start it with `npm run cli -- mcp` only when an MCP client owns the process.

Only run live commands when a key is available locally. Keep generated `out/` and snapshot files out of commits unless the task explicitly asks for public fixtures.

## Example regeneration

Use the documented random picker:

```bash
npm run examples:select
```

Do not hand-pick demonstration companies. Preserve the disclaimer in `README.md` and `examples/random-selection/README.md`.

## Commit, push, and release gates

Before commit:

```bash
npm run docs:links
npm run docs:mermaid
npm test
npm run typecheck
npm run lint
npm run verify:release
git diff --check
```

Before any push, refresh or verify the codebase-memory graph for the exact worktree and run a secret scan if tooling is available.

Do not change repository visibility. A human owner decides when a private repo becomes public.

## Privacy scan

Before commit or release, scan public files for:

- private planning paths;
- local home-directory paths;
- private API-key source paths;
- API key assignments;
- personal backstory or private thought process;
- generated outputs that contain secrets.

Public docs should describe the project and how to run it, not the private reasoning that led to it.
