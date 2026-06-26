# Company evidence schema parity

`uk-company-dossier` is the canonical owner of the company-evidence JSON Schema used across the Companies House portfolio. This document defines how downstream repositories pin and verify a copy. It is the authoritative source-of-truth referenced by the downstream repositories' own vendoring plans.

## Canonical artefacts

| Artefact | Path in this repository | Package export subpath |
|---|---|---|
| Schema | `schemas/company-evidence.schema.json` | `uk-company-dossier/schemas/company-evidence.schema.json` |
| Version | `schemas/VERSION` | `uk-company-dossier/schemas/VERSION` |

- Current schema version: `1.0.0`.
- Canonical schema SHA-256 (lowercase hex) at the pinned tag: `b143ecc05d3ea647b11c2cbbccd9637a728de5b555ec1a6ca7d46beedd81eef4`.
- Pinned source tag for downstream `source_tag`: `v0.1.1`.

## Downstream pinning rule

Downstream repositories (`uk-filing-guardian`, `uk-ownership-lens`, `uk-corporate-event-radar`) must:

1. Vendor a **byte-for-byte** copy of `schemas/company-evidence.schema.json` from the pinned tag. Do not reformat, re-key, minify, or re-serialise it; the bytes must hash to the canonical SHA-256.
2. Commit a manifest next to the vendored copy with exactly these fields:

   ```json
   {
     "source_repository": "uk-company-dossier",
     "source_tag": "v0.1.1",
     "source_path": "schemas/company-evidence.schema.json",
     "schema_version": "1.0.0",
     "sha256": "b143ecc05d3ea647b11c2cbbccd9637a728de5b555ec1a6ca7d46beedd81eef4"
   }
   ```

3. Never require this repository as an unpublished runtime dependency. The schema is vendored, not imported at runtime.

## Verification

Downstream CI recomputes the digest of its vendored copy and compares it to `sha256` in the manifest, and compares the manifest `source_tag` against this repository's published tag:

```bash
shasum -a 256 path/to/vendored/company-evidence.schema.json
# must equal the manifest sha256 and the canonical SHA-256 above
```

When this repository releases a new schema version, it publishes a new annotated tag; downstream repositories re-pin deliberately and update their manifest. Hidden coupling is prohibited; cross-repository reuse is small, explicit, and attributable.
