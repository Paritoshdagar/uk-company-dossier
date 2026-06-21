# Evidence-linked reference examples

Demonstration companies were selected programmatically by this repository's documented random-company picker from predeclared Companies House eligibility pools. The author did not choose or rank the selected companies. Inclusion does not imply endorsement, criticism, concern, affiliation, or preference. Public-register information is shown solely to demonstrate software behaviour, may change, and must be verified at Companies House before use.

This directory contains compact reference examples from the selected FTSE 350 demonstration companies. It is designed for readers who want to see what each Companies House data type looks like without opening a full raw API response.

## Files

- `reference-examples.json` is the technical reference pack. Each example includes selected fields plus Companies House evidence metadata.
- `reference-examples.md` is the same idea in a reader-friendly table.
- `index.json` lists the generated artifacts and selected companies.

## Evidence metadata

Successful source lookups include:

- `sourceUri`: the official Companies House API endpoint used.
- `retrievedAt`: when the source was retrieved.
- `payloadSha256`: a hash of the retrieved source payload.

Unavailable endpoints, such as a 404 insolvency endpoint, are recorded as availability examples with the attempted official endpoint and status code.

These files are examples for software evaluation. They are not legal, accounting, credit, compliance, risk, or investment advice. Public-register data changes, and important facts should be verified directly at Companies House.
