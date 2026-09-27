# Implementation and verification status

| Area | Implemented | Verification | Remaining external work / known limit |
| --- | --- | --- | --- |
| Local owner authentication, sessions, CSRF | Yes | API test, concurrent setup test and Chrome smoke test | Add MFA and user invitations before multi-user hosting. |
| SQLite migrations, encrypted credentials and body | Yes | Unit/API tests | One-process deployment; PostgreSQL and queue needed for horizontal scale. |
| Gmail dot/plus alias rules | Yes | Unit tests | Real Gmail alias delivery requires connected Gmail account. |
| Alias metadata, expiry, leak/spam tracking | Yes | API and Chrome smoke tests | Automated leak detection is not implemented. |
| Signed domain inbound and dedupe | Yes | API and Chrome smoke tests | Needs domain, MX, deployed adapter and real delivery check. |
| Mail tạm (Disposable Own-Domain Mailboxes) | Yes | API and Chrome smoke tests | Configurable TTL presets (15m, 1h, 24h, 7d) with automatic reject-after-expiry. |
| Unified inbox, search, OTP candidate | Yes | API and Chrome smoke tests | Search excludes encrypted body; OTP is heuristic and recency-scoped. |
| Gmail OAuth and inbox sync | Code implemented | Mocked provider contract and oversized-response tests | Client ID/Secret, consent, verification and live Gmail test required. |
| Microsoft OAuth (Hotmail/Outlook) and delta sync | Code implemented | Mocked provider contract and body-limit tests | App registration, consent and live Outlook/Hotmail/M365 test required. |
| IMAP TLS and Inbox sync | Code implemented | Syntax/build only | Live IMAP account test required; scans latest 500 messages and first 2 MB each. |
| Cloudflare Email Worker adapter | Code implemented | Local webhook tested; Worker not deployed | Configure Cloudflare routing, Worker secrets, HTTPS app URL and test real mail. |
| Windows & Android PWA Support | UI responsive and manifest present | Chrome responsive test | Android needs this same server on a trusted HTTPS address. |
| Export, deletion, backup | Yes | Export and deletion API/UI tests | Backup/restore procedure should be rehearsed with real data. |
| Deployment | Local run instructions | Automated build, test, browser smoke | No public deployment performed. |
| Security | Bootstrap token, singleton owner, alias uniqueness, provider limits, owner-only POSIX data paths | Targeted fixes, API/UI tests, `pnpm audit --prod` | No live provider test or production TLS certificate deployment yet. |

No provider credential, domain/DNS access, production hosting or real email address was provided during development. The tests do not represent a real provider connection or real message delivery.
