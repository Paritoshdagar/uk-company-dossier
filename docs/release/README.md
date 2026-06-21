# Release evidence

Release evidence is written to `release-evidence-private/release-evidence.json` by:

```text
npm run verify:release
```

The directory is intentionally ignored. It may contain commit SHAs, command statuses, schema hashes, dependency-lockfile hashes, and repository-visibility status. It must not contain API keys, private credential source paths, raw Companies House payloads, generated dossiers, Authorization headers, or personal data.

The evidence file is validated against `schemas/release-evidence.schema.json`.

The release gates are implemented as Node scripts so the same npm commands run on Windows, macOS, and Linux.

`npm run verify:release` is a maintainer gate. It expects GitHub CLI (`gh`) to be installed and authenticated so the repository visibility check can confirm the repo is still private before a scheduled release.

## Readiness language

Do not describe this repository as production-ready unless the exact commit being discussed has passed:

- fixture tests;
- documentation checks;
- typecheck, lint, build, and coverage;
- working-tree and Git-history secret scans;
- live Companies House REST checks with a user-owned key;
- representative CLI and MCP live checks;
- privacy review of any real-company examples;
- repository visibility check confirming the repo is still private before scheduled release.

If live checks were not run at the exact commit, say so plainly.
