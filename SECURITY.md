# Security policy

## Supported status

This repository is in private incubation. Security reports are accepted for the current `main` branch once the repository is made public.

## Reporting

Do not open public issues containing credentials, private company information, sensitive personal data, exploit payloads, or non-public vulnerability details.

For now, report only high-level reproducible security concerns without secrets or exploit details. A private disclosure route will be added before public release.

## Credential handling

Never commit `.env`, API keys, Authorization headers, generated live outputs that contain credential-bearing URLs, or private credential-source paths. Live Companies House checks must load credentials from a local environment source and must not print, hash, truncate, or otherwise expose key material.
