# Non-technical examples

Start with the guided workflow:

- [Non-technical company review](../../docs/use-cases/non-technical-company-review.md)

The recommended first output is Markdown:

```bash
mkdir -p out
npm run cli -- 00445790 --format markdown --output out/company-dossier.md
```

Read the dossier warnings, then verify important facts at Companies House. The generated dossier is a public-register summary, not professional advice.
