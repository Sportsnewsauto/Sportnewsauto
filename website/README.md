# Podcasti — Website

Next.js 15 application for Podcasti, running on the Cloudflare Worker `sportnewsauto` via Vinext. It uses Supabase Auth and PostgreSQL.

## Product decisions

- Light theme.
- Monthly and yearly subscription options with a free trial plan.
- Each account owns its Spreaker, Groq and Gemini credentials.
- Platform-provided Podcasti text-to-speech service.
- Automatic publishing or review-before-publishing.
- Account timezone defaults to Africa/Nairobi.
- Eight evenly spaced schedule times are the editable starting schedule.

## Production hosting

The production website and its API routes run on Cloudflare Workers.

- Website: https://sportnewsauto.kingsleyke.workers.dev
- Spreaker OAuth callback: https://sportnewsauto.kingsleyke.workers.dev/api/integrations/spreaker/callback
- Worker: `sportnewsauto`

Deploy the website through the Cloudflare Workers build connected to the `main` branch. The app's Cloudflare deployment configuration is in `website/cloudflare.config.ts`, and the Vinext/Vite integration is in `website/vite.config.ts`. The custom Worker entrypoint is `website/worker/index.ts`; it forwards normal web requests to Vinext and handles Cloudflare Cron Trigger events.

## Cloudflare Workers environment variables

Set production values in Cloudflare Dashboard → Workers & Pages → `sportnewsauto` → Settings → Variables and Secrets. Use `website/.env.local` for local development. Store private keys and encryption keys as **secrets**, not plain-text variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `APP_BASE_URL` — `https://sportnewsauto.kingsleyke.workers.dev`
- `SPREAKER_REDIRECT_URI` — `https://sportnewsauto.kingsleyke.workers.dev/api/integrations/spreaker/callback`
- `CREDENTIAL_ENCRYPTION_KEY` — server-only, base64-encoded 32-byte key for AES-256-GCM. Never prefix it with `NEXT_PUBLIC_`, commit it, or put it in browser code.
- `GITHUB_APP_ID` — the App ID (not Client ID) of the GitHub App used to start the worker immediately and on the Cloudflare schedule.
- `GITHUB_APP_PRIVATE_KEY` — the private key for that GitHub App. Keep it server-only; never prefix it with `NEXT_PUBLIC_` or commit it.
- `GITHUB_REPOSITORY` — repository in `owner/name` format; defaults to `Sportsnewsauto/Sportnewsauto`.
- `GITHUB_DEFAULT_BRANCH` — branch to dispatch; defaults to `main`.

The GitHub App must be installed on the `Sportsnewsauto/Sportnewsauto` repository and granted **Actions: write** permission. After changing the App permission, approve the permission update for the repository installation. The Cloudflare Worker uses the App private key to mint a short-lived installation token and dispatch `.github/workflows/multi-tenant-podcast-worker.yml`. No long-lived GitHub personal access token is stored by the website. The same dispatcher is used by the manual button and by the Cloudflare scheduled handler.

Cloudflare owns the recurring five-minute trigger. GitHub's `schedule` event is disabled; the GitHub workflow is started only by `workflow_dispatch` from Cloudflare or an immediate manual request from the site. GitHub Actions remains the execution runner for the Python audio-generation pipeline because that pipeline uses Python and audio dependencies that do not run inside the Cloudflare Worker runtime.

- No platform-wide Spreaker OAuth Client ID or Client Secret is required. Each workspace owner enters their own Client ID and Client Secret in Dashboard → API Connections; they are encrypted with that user's credential record.
- Each user's Spreaker Developer App must register this callback URL: `https://sportnewsauto.kingsleyke.workers.dev/api/integrations/spreaker/callback`.

Each user supplies their own Spreaker Developer App Client ID and Client Secret. The app credentials and the resulting access/refresh token bundle are encrypted and scoped to that signed-in user's workspace. No customer's OAuth application credentials are shared with another customer.

## GitHub Actions repository secrets for the multi-workspace worker

Before the worker can process accounts, add these repository secrets:

- `SUPABASE_SECRET_KEY` — the Supabase server-only Secret key (`sb_secret_...`). GitHub Actions only; never add it to website code or Cloudflare plain-text variables. The worker also accepts the older `SUPABASE_SERVICE_ROLE_KEY` name for a legacy `service_role` key.
- `CREDENTIAL_ENCRYPTION_KEY` — exactly the same base64 key as the Cloudflare Worker secret, so the worker can decrypt credentials saved by the website.
- No shared Spreaker app secrets are needed by the worker. It reads each user's own encrypted app credentials and token bundle.

The worker reads the existing `NEXT_PUBLIC_SUPABASE_URL` GitHub secret as `SUPABASE_URL`.

## Supabase setup

Run these SQL files in order in the Supabase SQL Editor:

1. `supabase/migrations/0001_accounts_and_workspaces.sql`
2. `supabase/migrations/0002_workspace_configuration_and_jobs.sql`
3. `supabase/migrations/0003_credential_security_and_job_idempotency.sql`
4. `supabase/migrations/0004_service_role_worker_table_grants.sql`
5. `supabase/migrations/0005_admin_workspace_plan.sql`
6. `supabase/migrations/0006_admin_import_profile_read.sql`
7. `supabase/migrations/0007_shared_ai_policy_and_script_length.sql`
8. `supabase/migrations/0008_user_voice_schedule_preferences.sql`
9. `supabase/migrations/0009_manual_automation_trial.sql`
10. `supabase/migrations/0010_free_script_limit.sql`

In Supabase Authentication → URL Configuration, set the Site URL to `https://sportnewsauto.kingsleyke.workers.dev` and allow the deployed authentication callback URL.

## Implemented

- Email/password registration, login, logout and password recovery screens.
- Protected dashboard, private workspaces and the owner username login.
- Podcast profile, AI provider/model, writing instructions, Podcasti voice, publishing mode, timezone and schedule preferences.
- Explicit per-workspace switch for scheduled episode generation; it is off by default.
- Per-account RSS feed management with starter sources from the existing automation, including league-specific football and Premier League feeds.
- Per-account advertising cue points; workspace values are passed to the worker and supported by the Spreaker upload script.
- Server-side AES-256-GCM encryption for Spreaker, Groq and Gemini credentials. Migration 0003 removes direct browser access to encrypted credential rows.
- Spreaker server-side OAuth authorization-code flow with CSRF state validation, encrypted access/refresh token storage, editable show selection and automatic access-token refresh.
- A multi-workspace Python podcast processor. It reads each workspace's own feeds, AI credentials, Spreaker show, schedule and ad slots; enforces plan allowances; supports scheduled publishing, review drafts and manual publishing.
- A one-click manual automation run. It queues the episode in Supabase and uses the same worker dispatcher used by the Cloudflare schedule.
- A Cloudflare Cron Trigger wakes the existing processor every five minutes. The processor checks each paid workspace's saved 2/4/6/8-hour interval, queues due episodes, and processes queued jobs. GitHub's own cron trigger is disabled; GitHub Actions only runs the processor when dispatched.
- Separate syntax checks for the Python worker and upload scripts.
- Episode and subscription screens.

## Still requires external setup

- Run all required Supabase migrations in order. Migration 0009 installs the secure manual-run queue function; migration 0010 enforces the free-plan narration character limit. Apply any newer pending migration files from `supabase/migrations` as part of the release process.
- Keep the GitHub App credentials as Cloudflare Worker secrets and grant the installed App Actions: write permission. The manual button and Cloudflare Cron Trigger both require these credentials to wake the processor.
- Each user registers the Cloudflare Worker callback URL in their own Spreaker Developer App, then saves their own Client ID and Client Secret under Dashboard → API Connections.
- Keep the GitHub Actions worker secrets listed above; they are required by the Python processor.
- For each workspace, connect Spreaker, select a show, connect the chosen Groq or Gemini provider, enable news feeds and then explicitly enable scheduled generation. The Cloudflare Cron Trigger wakes the processor every five minutes; the workspace's saved 2/4/6/8-hour interval determines when an episode is actually queued. The worker enforces each account's daily and rolling 30-day allowance.
- Accept Spreaker's Ad Exchange terms in the Spreaker account if you want Spreaker to use the submitted advertising cue points. Cue points are not the same as supplying your own ad audio or campaigns.
- Configure reliable email delivery for password recovery and account notifications. The built-in Supabase email service has restrictive default sending limits.
- Configure Safaricom Daraja sandbox/production credentials, the server-only Supabase secret key and public HTTPS callback URL before enabling M-Pesa subscriptions. A paid plan activates only after a verified Safaricom callback.

The legacy single-account workflow in `.github/workflows/podcast.yml` is manual-only and no longer scheduled. The multi-tenant GitHub Actions workflow is also manual-dispatch-only; Cloudflare owns the recurring trigger. Do not run both workflows for the same Spreaker show or put multiple users' credentials into the legacy workflow's shared repository secrets.
