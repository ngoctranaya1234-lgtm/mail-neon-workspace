# API v1

All JSON routes live under `/api/v1`. Success: `{ "data": ... }`; error: `{ "error": { "code", "message", "request_id" } }`. Authenticated routes require the HttpOnly `workspace_session` cookie. `POST`, `PATCH`, and `DELETE` require `X-CSRF-Token` from `/api/v1/me` or login/setup response. Only the signed email inbound webhook is exempt. Request bodies are JSON. Pagination uses `limit`/`offset` where present.

| Method | Path | Action |
| --- | --- | --- |
| GET | `/config` | Setup required, provider availability, owned domain. |
| POST | `/setup` | Create the sole owner with `email`, `password`, and server-side `SETUP_TOKEN`; claim is atomic. |
| POST | `/login` | Create session. |
| GET | `/me` | Current user and CSRF token. |
| POST | `/logout` | Revoke current session. |
| POST | `/account/credentials` | Change owner email and password after proving current password or `SETUP_TOKEN`. |
| DELETE | `/account` | Confirm password, delete owner and local data. |
| GET | `/summary` | Real counts for mailboxes, aliases, emails and unread. |
| GET | `/mailboxes` | Mailboxes and capability descriptors. |
| POST | `/mailboxes/imap` | Test TLS login, then save encrypted credentials. |
| POST | `/oauth/{google\|microsoft}/start` | Return official authorization URL. |
| GET | `/oauth/{google\|microsoft}/callback` | Validate state/PKCE and connect mailbox. |
| POST | `/mailboxes/{id}/sync` | Sync real provider; returns `{inserted,complete}`. |
| DELETE | `/mailboxes/{id}` | Disconnect, attempt Google revoke, delete local data. |
| GET | `/aliases` | Search/list alias metadata. |
| GET | `/aliases/preview` | Candidate Gmail dot variants. |
| POST | `/generator/dots` | Generate Gmail dot variants without creating a mailbox; `mode=combined` returns shuffled, unique results with category labels, while `mode=categorized` uses one `pattern` (`binary`, `random`, `one_dot`, `two_dots`, `alternating`). `count` is 1–2,000 per request. |
| POST | `/generator/plus` | Generate Gmail plus variants without creating a mailbox. Use `count` 1–2,000 and decimal `offset` to fetch successive pages; the response includes `nextOffset`. There is no fixed total-count cap. |
| POST | `/generator/save-batch` | Save variants only against the connected Gmail mailbox they belong to. |
| POST | `/aliases` | Create verified Gmail dot/plus or owned-domain alias. |
| PATCH | `/aliases/{id}` | Update lifecycle, metadata, leak and spam status. |
| DELETE | `/aliases/{id}` | Delete alias. |
| GET | `/messages` | Search/list message metadata. |
| GET | `/messages/{id}` | Decrypt text, calculate OTP candidate. |
| PATCH | `/messages/{id}` | Mark read. |
| DELETE | `/messages/{id}` | Delete message. |
| POST | `/inbound` | HMAC signed owned-domain mail ingest; no cookie. |
| GET | `/export` | Export metadata without secrets/body/OTP. |
| GET | `/audit` | Last 100 sensitive action records. |
| POST | `/system/clean` | Quick expiry cleanup, or password/token protected full data cleanup with backup. |

`GET /healthz` is outside `/api/v1` and checks database readiness. Domain inbound contract and signature construction are documented in README. The OAuth callback is a navigation endpoint; it redirects to `/` on success or failure and does not return tokens to the browser.

The Dot Trick response retains `variants` as an array of addresses and adds `details` with each address's category codes. `totalVariants` counts dotted aliases only, excluding the original undotted Gmail address. `binary` remains available for clients that need repeatable ordering; `combined` and `random` use fresh random selection. Plus pages continue for any positive total requested by the client, subject to Gmail's 64-character local-part limit and the machine's available resources. Neither endpoint creates a new mailbox or guarantees delivery without connecting the owner Gmail account.
