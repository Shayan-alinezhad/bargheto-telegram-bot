# Security Policy

## Reporting a vulnerability

Please do not publish security issues containing credentials or personal data.
Report sensitive vulnerabilities privately to the maintainer through the contact methods available on the maintainer's GitHub profile:

https://github.com/Shayan-alinezhad

## Secrets

The following values must never be committed:

- `BOT_TOKEN`
- `WEBHOOK_SECRET`
- `ADMIN_PASSWORD`
- `.env` and `.dev.vars` files

If a Telegram token is exposed, revoke it immediately through `@BotFather`, create a new token, update the Cloudflare Secret, deploy, and open `/setup` again.
