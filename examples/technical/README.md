# Technical examples

Start with the integration workflow:

- [Technical evidence integration](../../docs/use-cases/technical-evidence-integration.md)

The recommended first output is JSON:

```bash
mkdir -p out
npm run cli -- 00445790 --format json --output out/company-dossier.json
```

Use the JSON Schema in `schemas/company-evidence.schema.json` when building downstream parsers. For coding agents, use the MCP templates in `docs/mcp/`.
