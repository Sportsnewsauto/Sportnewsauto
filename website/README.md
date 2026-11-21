# Automate Spreaker Podcast — Website

Next.js 15 website for Automate Spreaker Podcast, using Supabase Auth and PostgreSQL.

## Product decisions

- Light theme.
- Monthly subscription model; free plan allows one episode per day.
- Each account owns its own Spreaker, Groq and Gemini credentials.
- Platform-provided Kokoro text-to-speech.
- Automatic publishing or review-before-publishing preference.
- Account timezone defaults to Africa/Nairobi.
- Eight evenly spaced schedule times are provided as an editable starting schedule.

## Environment variables

Set these in Vercel (and in `website/.env.local` for local development):

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `CREDENTIAL_ENCRYPTION_KEY` — server-only, base64-encoded 32-byte key used by the AES-256-GCM credential vault. Never prefix it with `NEXT_PUBLIC_`, commit it, or add it to browser code.\n- `SPREAKER_CLIENT_ID` — OAuth application Client ID from Spreaker Developers.\n- `SPREAKER_CLIENT_SECRET` — OAuth application Client Secret from Spreaker Developers. Server-only; never add it to browser code.\n- `SPREAKER_REDIRECT_URI` — exact callback URL registered in Spreaker Developers: `https://sportnewsauto.vercel.app/api/integrations/spreaker/callback`.

The public Supabase publishable key is safe to expose in the browser when Row Level Security is correctly enabled. Never use a Supabase service-role key in the website.

## Supabase setup

1. Create a Supabase project.
2. Set the project URL and publishable key in the environment variables.
3. In Supabase SQL Editor, run `supabase/migrations/0001_accounts_and_workspaces.sql`.
4. Then run `supabase/migrations/0002_workspace_configuration_and_jobs.sql`.
5. In Supabase Authentication → URL Configuration, set the Site URL to the deployed website and add the deployed `/auth/callback` URL as an allowed redirect.
6. Deploy the website.

The second migration adds per-user workspace settings, RSS feed records, advertising cue-point settings, episode and publishing-job records, integration status, encrypted provider credential storage, and owner-checked credential RPC functions.

## Implemented

- Email/password registration, confirmation, login and logout.
- Protected dashboard and private workspaces.
- Working dashboard navigation with individual section pages.
- Podcast profile, AI provider/model, writing instruction, Kokoro voice, publishing mode, timezone and schedule preferences.
- Per-account RSS feed management with starter sources based on the existing repository feed configuration.
- Per-account advertising cue-point positions, including 30, 60, 120 and 180 seconds as starter slots.
- Server-side AES-256-GCM encryption for Spreaker, Groq and Gemini credentials.\n- Spreaker server-side OAuth authorization-code flow with CSRF state validation, encrypted access/refresh token storage, and automatic access-token refresh.
- Provider credential verification endpoints for Spreaker `GET /v2/me`, Groq model listing and Gemini model listing.
- Episode list and subscription status screens.

## Still requires external setup or implementation

- Apply Supabase migration 0002 before using saved settings, feeds, advertising or integrations.
- Add `CREDENTIAL_ENCRYPTION_KEY` to Vercel before saving provider credentials.
- Complete actual per-user episode generation, audio rendering, ad insertion, review/publish execution and Spreaker publishing worker integration.\n- Register the Spreaker OAuth app and add the three Spreaker OAuth environment variables to Vercel before the Connect Spreaker button can be used.
- Configure a secure background worker to process queued jobs. The existing repository-wide GitHub Actions automation is separate and must not be treated as a multi-tenant worker.
- Connect a payment provider and define paid plan pricing before charging users.

The website does not currently generate or publish episodes from these saved settings. UI status labels must remain clear until a secure background worker is deployed and tested.
