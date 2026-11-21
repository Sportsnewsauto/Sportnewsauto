# Automate Spreaker Podcast — Website

Next.js 15 frontend with Supabase Auth and PostgreSQL as the first real account/database foundation.

## Product decisions

- Light theme.
- Monthly subscriptions; free plan allows one episode per day.
- Users bring their own Groq/Gemini and Spreaker credentials.
- Platform-provided Kokoro text-to-speech.
- Automatic publishing or review-and-approve mode.

## Supabase setup

1. Create a Supabase project.
2. In **Project Settings → API**, copy the project URL and anon/public key.
3. Put them in `website/.env.local` as `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
4. In Supabase **SQL Editor**, run `supabase/migrations/0001_accounts_and_workspaces.sql`.
5. In Supabase **Authentication → URL Configuration**, set the Site URL to your deployed website (or `http://localhost:3000` while developing) and add the matching `/auth/callback` redirect URL.
6. Run the site with `cd website && npm install && npm run dev`.

Email/password registration and login are enabled. If email confirmation is enabled in Supabase, users must confirm their email before signing in. The dashboard requires a valid Supabase session.

## Database and security

The migration creates a profile and one private workspace per user. A database trigger creates them when Supabase Auth creates a user. Row Level Security policies restrict profile/workspace reads and writes to the authenticated owner. The browser only receives the Supabase anon key; never put a service-role key in the website.

## Current scope and limitations

Implemented: registration, login, logout, session-aware dashboard, and private profile/workspace tables.

Not yet implemented: integration credential forms/storage, credential encryption, per-user podcast jobs, episode records, payment/billing, and Spreaker publishing. Do not collect provider API keys until the server-side encrypted credential vault is implemented.

## Production architecture

Deploy the Next.js site and FastAPI API to persistent hosting, and use Supabase for Auth/PostgreSQL. GitHub Actions may remain a bounded processing worker, but it is not the web server or database.
