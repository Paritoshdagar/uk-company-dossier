# Use case: non-technical company review

This workflow is for a user who wants a structured, repeatable way to look at public Companies House information without writing code.

## Goal

Create a dossier, read the warnings, and use evidence links to verify important points directly at Companies House.

## Before you start

1. Install the project.
2. Copy `.env.example` to `.env`.
3. Create your own Companies House API key using the README instructions.
4. Run:

```bash
npm run cli -- doctor --live
```

## Example workflow

Generate a Markdown dossier:

```bash
npm run cli -- 00445790 --format markdown --output out/company-dossier.md
```

Open `out/company-dossier.md` and review:

- the company name and number;
- section warnings;
- filing-history dates;
- officers and persons with significant control;
- charges and insolvency sections;
- source attribution and retrieval caveats.

Save a snapshot for later comparison:

```bash
npm run cli -- snapshot save 00445790 --snapshot-dir .snapshots
```

Repeat later and compare snapshots:

```bash
npm run cli -- snapshot compare .snapshots/before.json .snapshots/after.json
```

## How to use the result safely

Use the dossier as a structured starting point. It is not legal, accounting, compliance, credit, investment, or risk advice. Verify important facts at Companies House before relying on them.
