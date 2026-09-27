# INTERNAL MASTER SPECIFICATION: Universal Mail Identity & OTP Workspace

## 1. Product Scope & Objectives
The Universal Mail Identity & OTP Workspace is a self-hosted system for email identities and temporary addresses controlled by the owner, with a responsive interface for Windows and Android browsers.

### Core Capabilities:
1. **Gmail Dot Trick & Plus Addressing Engine**:
   - Canonicalizes `local-part` for `@gmail.com` addresses.
   - Generates combinatorial dot variants without creating fake accounts.
   - Generates tag-based plus addresses (`user+tag@gmail.com`).
   - Tracks destination aliases, service labels, purpose, spam/leak statuses, and active lifecycle.
2. **Microsoft / Hotmail / Outlook Integration**:
   - Integrates official Microsoft Graph OAuth (supporting consumer Hotmail/Outlook.com accounts and M365 organization accounts where tenant policies permit).
   - Syncs Inbox mail via Microsoft delta sync with delegated `Mail.Read` and `offline_access`.
   - Also supports TLS IMAP connection for legacy or custom Outlook configurations.
3. **Mail Tạm / Disposable Own-Domain Mailboxes**:
   - Manages temporary email addresses on user-controlled domains (`@yourdomain.com`).
   - Ingests incoming mail via signed HMAC-SHA256 inbound webhooks (e.g., Cloudflare Email Worker adapter).
   - Configurable TTL (15m, 1h, 24h, 7d), active countdown, and auto-rejection after expiration.
4. **Cross-Platform Daily Usability on Windows & Android**:
   - Progressive Web App (PWA) with manifest, touch-friendly UI design tokens, responsive desktop/mobile viewports, and zero-dead-button guarantee.
5. **Strict Non-Goals & Anti-Abuse Compliance**:
   - Absolutely NO CAPTCHA/anti-bot bypass.
   - Absolutely NO bulk automated account registration or credential stuffing.
   - All features operate on accounts and domains controlled by the operator.

---

## 2. Repository & State Inventory
- **Runtime**: Node.js v24.19.0 (native `node:sqlite` DatabaseSync, native crypto).
- **Package Manager**: pnpm v11.19.0.
- **Database**: SQLite with Write-Ahead Logging (`PRAGMA journal_mode=WAL`), foreign keys enabled, single-owner constraint.
- **Crypto & Secrets**: AES-256-GCM for credential ciphers and message bodies; scrypt for password hashing with random salt; HMAC-SHA256 for session hashes and webhook signatures.
- **Frontend**: Vanilla ES modules, responsive semantic CSS, PWA manifest (`manifest.webmanifest`), standalone display mode.

---

## 3. Proactive Technical Additions & Missing Requirements Addressed
1. **Temporary Mail Quick Actions**:
   - Dedicated 1-click generator for disposable temporary addresses with preset TTL countdowns.
2. **Email OTP Context Engine**:
   - OTP candidate extraction from email in Vietnamese and English.
3. **Cross-Platform UX Optimization**:
   - Mobile-friendly touch targets (min 44px), sticky bottom navigation for Android, side navigation for Windows/desktop, and offline error boundaries.

---

## 4. Conflict Analysis & Resolution
| Conflict / Tension | Master Directive Constraint | Safe Production Resolution |
| :--- | :--- | :--- |
| **Gmail Dot Trick Semantics** | Third-party services might view dots as distinct accounts; Google views them as the same mailbox. | Clearly treat dot variants as **aliases** belonging to the parent canonical Gmail mailbox. Never simulate account creation or present variants as new accounts. |
| **Outlook vs Hotmail vs M365** | Microsoft has personal (Live/Hotmail) and organizational (Entra ID) endpoints. | Use the `common` or `consumers` OAuth endpoint supporting both personal Microsoft accounts (Hotmail/Outlook.com) and tenant accounts with delegated `Mail.Read`. Fall back to IMAP TLS for direct mailbox credentials. |

---

## 5. Requirement Matrix (Khối 01 to Khối 37)
- **Khối 01–02 (Meta & Agent Contract)**: Full audit before changes; no fake responses; no dead buttons; incremental verified milestones.
- **Khối 03 (Skills Discovery)**: Audited `ui-ux-design` and `backend-engineering` skills documented and verified; Supabase skills referenced for future Postgres migrations.
- **Khối 04–06 (PRD, Architecture & Tech Stack)**: Single-process Node 24 + SQLite WAL architecture; decoupled provider adapters; zero client-side credentials.
- **Khối 07 (Auth & Identity)**: Single-owner setup with out-of-band `SETUP_TOKEN`; scrypt password hash; HttpOnly Lax SameSite cookies; `X-CSRF-Token` enforcement.
- **Khối 08–09 (Gmail Dot Trick & Plus)**: BigInt combinatorial dot variant generator (limit 50); tag sanitization; Google OAuth with PKCE and readonly scope.
- **Khối 10 (Outlook / Hotmail)**: Microsoft Graph OAuth with PKCE; `Mail.Read` delegated scope; delta token synchronization.
- **Khối 11 (IMAP TLS)**: TLS verification; test connection before save; credentials encrypted at rest with AES-256-GCM.
- **Khối 12 (Domain Temp Mail)**: Signed inbound webhook with HMAC-SHA256 timestamp replay protection; configurable TTL.
- **Khối 13–14 (Provider Adapters & Normalization)**: Standardized message ingest, MIME parsing, plain text normalization, HTML stripping/sanitization.
- **Khối 15 (OTP Extraction)**: Heuristic regex extraction with context keywords in Vietnamese and English; 15-minute validity window.
- **Khối 16 (Identity & Alias Manager)**: Lifecycle tracking, leak status, spam status, last used timestamps.
- **Khối 17–20 (UI/UX, Dashboard, Unified Inbox, Search)**: Responsive PWA layout for Windows & Android, real counters, instant search, OTP 1-click copy.
- **Khối 21–25 (Backend API, DB, RLS, Secrets & Sync)**: Versioned JSON API, AES-256-GCM, rate-limiting by IP with trusted proxy support.
- **Khối 26–37 (Tests, Observability, Compliance & Delivery)**: Comprehensive unit/integration tests, zero fake metrics, complete setup documentation.

---

## 6. Architecture Plan
```
+--------------------------------------------------------------------------+
|                  Client Layer (Windows Desktop & Android Mobile)          |
|  - Standalone PWA / Responsive UI (Touch-friendly, Design Tokens)       |
|  - Generator, Unified Inbox, Alias Manager, Connections                  |
+------------------------------------+-------------------------------------+
                                     | HTTPS / Fetch (JSON, CSRF Token)
+------------------------------------v-------------------------------------+
|                  Application Gateway & HTTP Server (Node.js)             |
|  - Security Headers (CSP, HSTS, X-Frame-Options: DENY, nosniff)          |
|  - Session Authenticator (scrypt, HttpOnly cookie, CSRF validation)      |
|  - Rate Limiter (IP tracking + Trusted Proxy subnet support)             |
+------------------------------------+-------------------------------------+
                                     |
+------------------------------------v-------------------------------------+
|                  Business Logic & Domain Layer                            |
|  - Gmail Canonicalization & Combinatorial Dot Generator                  |
|  - Gmail Plus Tag Validator & Owned Domain Disposable Mailbox Gen        |
|  - Heuristic OTP Engine (Email Context, Multi-language)                  |
+------------------------------------+-------------------------------------+
                                     |
+------------------------------------v-------------------------------------+
|     Email Provider Adapters                                             |
|  - Google OAuth / Gmail API, Microsoft Graph OAuth (Hotmail)            |
|  - IMAP TLS Adapter, Cloudflare Inbound Webhook                          |
+------------------------------------+-------------------------------------+
                                     |
+------------------------------------v-------------------------------------+
|                  Data Access & Crypto Layer (SQLite WAL)                 |
|  - AES-256-GCM cipher for credentials & message bodies                   |
|  - Tables: users, sessions, mailboxes, aliases, messages,                |
|            oauth_states, audit_events                                    |
+--------------------------------------------------------------------------+
```

---

## 7. Data Model
### Tables:
1. `users`: `id`, `email`, `password_hash`, `created_at` (Single-owner constraint).
2. `sessions`: `token_hash`, `user_id`, `csrf_token`, `expires_at`, `created_at`.
3. `mailboxes`: `id`, `user_id`, `provider` ('google'|'microsoft'|'imap'|'domain'), `address`, `label`, `credential_cipher`, `cursor`, `status`, `last_sync_at`, `last_error`, `created_at`.
4. `aliases`: `id`, `user_id`, `mailbox_id`, `address`, `kind` ('dot'|'plus'|'domain'), `purpose`, `source`, `status` ('active'|'archived'), `notes`, `leak_status` ('unknown'|'suspected'|'confirmed'), `spam_status` ('none'|'observed'|'high'), `expires_at`, `last_used_at`, `created_at`.
5. `messages`: `id`, `user_id`, `mailbox_id`, `provider_message_id`, `sender`, `recipients`, `subject`, `body_cipher`, `received_at`, `alias_id`, `is_read`, `created_at`.
6. `oauth_states`: `state_hash`, `user_id`, `provider`, `verifier`, `expires_at`.
7. `audit_events`: `id`, `user_id`, `action`, `target_id`, `created_at`.

---

## 8. API Contract
Standard envelope: `{ "data": ... }` or `{ "error": { "code", "message", "request_id" } }`.

### Authentication & Account:
- `POST /api/v1/setup`: `{ email, password, setupToken }` -> `{ user, csrf }`
- `POST /api/v1/login`: `{ email, password }` -> `{ user, csrf }`
- `POST /api/v1/logout`: Revokes session cookie.
- `GET /api/v1/me`: Returns current user and active CSRF token.
- `DELETE /api/v1/account`: Deletes owner account and local data.

### Mailboxes & OAuth:
- `GET /api/v1/mailboxes`: List connected mailboxes with capabilities.
- `POST /api/v1/mailboxes/imap`: Connect IMAP mailbox with TLS test.
- `POST /api/v1/oauth/:provider/start`: Returns OAuth redirect URL.
- `GET /api/v1/oauth/:provider/callback`: Navigation callback handling PKCE & exchange.
- `POST /api/v1/mailboxes/:id/sync`: Triggers synchronization.
- `DELETE /api/v1/mailboxes/:id`: Disconnects mailbox and purges data.

### Aliases & Disposable Mail:
- `GET /api/v1/aliases`: Filter and search aliases.
- `GET /api/v1/aliases/preview`: Candidate Gmail dot variants.
- `POST /api/v1/aliases`: Create dot, plus, or domain disposable address.
- `PATCH /api/v1/aliases/:id`: Update status, notes, leak/spam tracking.
- `DELETE /api/v1/aliases/:id`: Delete alias.

### Email Messages:
- `GET /api/v1/messages`: Search and paginate emails.
- `GET /api/v1/messages/:id`: Decrypt body text and compute OTP candidate.
- `PATCH /api/v1/messages/:id`: Mark as read.
- `DELETE /api/v1/messages/:id`: Delete message.
- `POST /api/v1/inbound`: Signed HMAC-SHA256 email ingest webhook.

---

## 9. Security Model
1. **Zero-Trust Credential Storage**: All OAuth refresh tokens and IMAP passwords encrypted with AES-256-GCM.
2. **Private Message Storage**: Email bodies are encrypted at rest.
3. **Session & CSRF Hardening**: Random 256-bit tokens, hashed with HMAC pepper; HttpOnly SameSite=Lax cookies; double-submit header validation.
4. **Rate Limiting**: IP-based rate limiting with trust validation for reverse proxies.
5. **No Dangerous Content Execution**: Email HTML is converted/stripped to safe text; no remote tracking pixels; no executable scripts.

---

## 10. Testing Strategy
- Unit tests: Dot trick combinatorial math, plus tag sanitizing, OTP heuristic parsing, crypto cipher/scrypt.
- Integration tests: Auth flow, CSRF enforcement, concurrent setup lock, signed email webhook, OAuth state handling.
- UI Smoke tests: Full Playwright workflow for both desktop and mobile viewports.

---

## 11. Acceptance Criteria
1. `pnpm test` passes 100% of unit and integration test assertions.
2. Gmail Dot Trick preview and generator work without collision or fake accounts.
3. Hotmail / Outlook connection and delta sync paths are available through OAuth.
4. Temporary Mail creates owned-domain aliases with expiry and reject-after-expiry logic.
5. Web UI works on Windows and Android through the same HTTPS origin.
