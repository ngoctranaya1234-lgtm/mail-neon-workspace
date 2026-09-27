# Cloudflare Email Worker adapter

This adapter forwards real inbound mail from a domain you control to the app's signed webhook. It uses Cloudflare's SMTP envelope recipient (`message.to`), parses MIME with `postal-mime`, sends only plain text and metadata, and never forwards attachments. Configure Email Routing for your domain and route inbound mail to this Worker. Cloudflare's dashboard manages the MX records; verify they are active before claiming mail receipt.

1. Bundle `cloudflare-email-worker.mjs` with `postal-mime` using Wrangler or your Worker build tool.
2. Set Worker secrets `WORKSPACE_WEBHOOK_URL=https://your-app.example/api/v1/inbound` and `WORKSPACE_WEBHOOK_SECRET` equal to the app's `INBOUND_WEBHOOK_SECRET`.
3. Set the app's `OWNED_MAIL_DOMAIN` to the same domain and restart it. Create a domain alias in the UI.
4. Send a real message to that alias and check the app inbox. Unknown aliases return 404 and the Worker rejects the address.

The app must be reachable over HTTPS from Cloudflare. Email Routing/Worker delivery, domain ownership, MX and DNS are external requirements. The Worker throws on upstream failure; inspect Cloudflare logs and the sender's delivery status for provider retry behavior. Do not assume retry or successful delivery until a real end-to-end test passes.
