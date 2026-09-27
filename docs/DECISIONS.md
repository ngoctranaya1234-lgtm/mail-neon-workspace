# Architecture decisions

1. **Self-hosted SQLite first.** It gives a real database and deterministic local verification with no third-party account. It limits this release to one process. PostgreSQL/Supabase is deferred until scale or hosted multi-tenant operation is required.
2. **Read-only provider integrations.** Gmail and Microsoft permissions only read inboxes. The local SMTP receiver accepts inbound mail for owned-domain aliases; the app does not send mail.
3. **No HTML rendering.** Message bodies are converted to plain text before display, avoiding active mail content and remote tracking images.
4. **One owner at setup.** An out-of-band setup token, an atomic claim, and a SQLite singleton constraint close public registration and concurrent setup races. Multi-user invitations are a later capability, while ownership columns exist from the start.
5. **Native Node server.** The small API avoids framework dependency and keeps deploy/install simple; dedicated libraries handle IMAP and MIME parsing.
