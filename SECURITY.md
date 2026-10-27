# Security Policy

## Supported Versions

Security fixes are made against the latest code on `main`. Include the affected deployed version or commit when reporting an issue.

## Reporting a Vulnerability

Use GitHub's private vulnerability reporting for this repository: open **Security → Advisories → Report a vulnerability**. The repository must have private vulnerability reporting enabled for this form to be available. If it is unavailable, do not post vulnerability details in a public issue; open a public issue containing only a request for a private reporting channel.

Include the affected route or component, version or commit, impact, and concise reproduction steps. Share only test accounts and sanitized logs. Never include live wallet keys, signed XDR, session cookies, access tokens, or other wallet secrets.

## Suspected Credential Compromise

Stop the affected integration. Revoke exposed sessions and tokens, rotate affected credentials, and move funds to a new wallet if a wallet secret was exposed. Preserve relevant timestamps, request IDs, and transaction hashes, then report the incident privately. Do not include the compromised secret in the report.
