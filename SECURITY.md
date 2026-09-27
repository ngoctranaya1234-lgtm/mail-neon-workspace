# Security policy and review scope

Review authentication, session/CSRF handling, cross-user access, alias ownership, inbound webhook authentication and replay/deduplication, OAuth state/PKCE and token storage, IMAP credential storage/TLS, HTML/message handling, export and deletion, provider URL trust, and local database/backup confidentiality. Test code may use synthetic addresses and tokens. No real user secrets should be committed or included in reports.

The application is self-hosted and designed for one process. Provider accounts, DNS, public OAuth verification, reverse proxy and physical host security are deployment dependencies. Findings about those components should identify the missing deployment evidence rather than assume success.

Report security vulnerabilities through the repository maintainer's private channel; do not put secret values, OTPs, message bodies or exploit data in public issues.
