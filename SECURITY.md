# Security Policy

Security fixes target the latest release on `main`.

Do not open a public issue containing credentials, private memory, database contents or exploit details. Use GitHub private vulnerability reporting. If it is unavailable, request a private contact channel without posting sensitive details.

If a credential is exposed, revoke or rotate it immediately, update the corresponding local/Supabase secret, review access logs and remove it from Git history. Deleting only the latest commit is not sufficient.

Never commit `.dev.vars`, `.env`, `imports/private/`, historical imports, exports or production memory.
