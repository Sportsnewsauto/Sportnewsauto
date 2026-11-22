# Automate Spreaker Podcast — Website

Next.js 15 website for Automate Spreaker Podcast, using Supabase Auth and PostgreSQL.

## Product decisions

- Light theme.
- Monthly subscription model; the free plan allows one episode per day.
- Each account owns its Spreaker, Groq and Gemini credentials.
- Platform-provided Podcasti text-to-speech service.
- Automatic publishing or review-before-publishing.
- Account timezone defaults to Africa/Nairobi.
- Eight evenly spaced schedule times are the editable starting schedule.

## Vercel environment variables

Set these in the Vercel project (and in `website/.env.local` for local development):

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `CREDENTIAL_ENCRYPTION_KEY` — server-only, base64-encoded 32-byte key for AES-256-GCM. Never prefix it with `NEXT_PUBLIC_`, commit it, or put it in browser code.
- No platform-wide Spreaker OAuth Client ID or Client Secret is required. Each workspace owner enters their own Client ID and Client Secret in Dashboard → API Connections; they are encrypted with that user's credential record.
- Each user's Spreaker Developer App must register this callback URL: `https://sportnewsauto.vercel.app/api/integrations/spreaker/callback`.

Each user supplies their own Spreaker Developer App Client ID and Client Secret. The app credentials and the resulting access/refresh token bundle are encrypted and scoped to that signed-in user's workspace. No customer's OAuth application credentials are shared with another customer.

## GitHub Actions repository secrets for the multi-workspace worker

Before the worker can process accounts, add these repository secrets:

- `SUPABASE_SECRET_KEY` — the Supabase server-only Secret key (`sb_secret_...`). GitHub Actions only; never add it to website code or Vercel public variables. The worker also accepts the older `SUPABASE_SERVICE_ROLE_KEY` name for a legacy `service_role` key.
- `CREDENTIAL_ENCRYPTION_KEY` — exactly the same base64 key as the Vercel value, so the worker can decrypt credentials saved by the website.
- No shared Spreaker app secrets are needed by the worker. It reads each user's own encrypted app credentials and token bundle.

The worker reads the existing `NEXT_PUBLIC_SUPABASE_URL` GitHub secret as `SUPABASE_URL`.

## Supabase setup

Run these SQL files in order in the Supabase SQL Editor:

1. `supabase/migrations/0001_accounts_and_workspaces.sql`
2. `supabase/migrations/0002_workspace_configuration_and_jobs.sql`
3. `supabase/migrations/0003_credential_security_and_job_idempotency.sql`

In Supabase Authentication → URL Configuration, set the Site URL to the deployed website and allow the deployed authentication callback URL.

## Implemented

- Email/password registration, login, logout and password recovery screens.
- Protected dashboard, private workspaces and the owner username login.
- Podcast profile, AI provider/model, writing instructions, Podcasti voice, publishing mode, timezone and schedule preferences.
- Explicit per-workspace switch for scheduled episode generation; it is off by default.
- Per-account RSS feed management with starter sources from the existing automation, including league-specific football and Premier League feeds.
- Per-account advertising cue points; workspace values are passed to the worker and supported by the Spreaker upload script.
- Server-side AES-256-GCM encryption for Spreaker, Groq and Gemini credentials. Migration 0003 removes direct browser access to encrypted credential rows.
- Spreaker server-side OAuth authorization-code flow with CSRF state validation, encrypted access/refresh token storage, editable show selection and automatic access-token refresh.
- A separate multi-workspace GitHub Actions worker. It reads each workspace's own feeds, AI credentials, Spreaker show, schedule and ad slots; enforces the saved daily episode limit; supports automatic publishing, review drafts and manual publishing from the Episodes screen.
- Separate syntax checks for the Python worker and upload scripts.
- Episode and subscription screens.

## Still requires external setup

- Run migration 0003 in Supabase before using the new credential-removal RPC, automation switch and worker idempotency.
- Each user registers the website callback URL in their own Spreaker Developer App, then saves their own Client ID and Client Secret under Dashboard → API Connections.
- Add the GitHub Actions worker secrets listed above. The new worker is safely inactive until these are present.
- For each workspace, connect Spreaker, select a show, connect the chosen Groq or Gemini provider, enable news feeds and then explicitly enable scheduled generation. The worker runs on the eight Nairobi-time schedule checks and enforces each workspace's daily limit.
- Accept Spreaker's Ad Exchange terms in the Spreaker account if you want Spreaker to use the submitted advertising cue points. Cue points are not the same as supplying your own ad audio or campaigns.
- Configure reliable email delivery for password recovery and account notifications. The built-in Supabase email service has restrictive default sending limits.
- Connect a payment provider and define paid plan prices before accepting subscriptions. Payments are not enabled and no charges are made by the site.

The existing single-account workflow in `.github/workflows/podcast.yml` remains separate and unchanged. Do not put multiple users' credentials into that workflow's shared repository secrets.
