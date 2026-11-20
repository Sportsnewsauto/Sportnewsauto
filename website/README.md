# Automate Spreaker Podcast — Website

This folder contains the initial Next.js frontend for **Automate Spreaker Podcast**.

## Product decisions

- Light-theme responsive interface.
- Monthly subscriptions with a free plan.
- Free plan allowance: one episode per day.
- Users bring their own Groq and/or Gemini API keys.
- Users connect their own Spreaker access token and show ID.
- Platform-provided Kokoro text-to-speech.
- Publishing modes: automatic or review-and-approve.
- Existing Python podcast automation remains the processing-engine starting point.

## Run locally

Requirements: Node.js 20 or later.

```bash
cd website
npm install
npm run dev
```

Open http://localhost:3000.

## Current implementation status

The homepage and dashboard are visual frontend prototypes. They do not yet provide real registration, login, credential storage, payments, background jobs or Spreaker publishing.

## Planned production architecture

- Next.js frontend and authenticated dashboard.
- Python FastAPI backend for account-scoped application APIs.
- PostgreSQL for users, encrypted integration settings, schedules, plans and episode records.
- GitHub Actions for scheduled and queued podcast-processing jobs in the initial deployment.
- Platform-hosted Kokoro workers for audio generation.
- GitHub repository dispatch or a secured job-queue bridge to trigger per-user jobs.
- A payment provider for monthly billing.

## Security requirements before launch

- Never put provider API keys in frontend environment variables or browser code.
- Encrypt user credentials using a server-side key stored outside the repository.
- Do not log credentials or return raw secrets from APIs.
- Enforce ownership checks on every user-specific record and job.
- Add per-user job locking, idempotency and subscription-limit checks.
- Use a separate GitHub service identity with minimum permissions; never expose a GitHub token to the browser.
- Do not store user secrets in GitHub repository files, commits, workflow logs or shared repository secrets.

## GitHub Actions limitation

GitHub Actions is suitable for scheduled and bounded processing jobs, but it is not a persistent web server, user database or always-on queue. The public website and API will need a web host and managed database. Actions can remain the initial execution layer for scheduled podcast jobs, subject to GitHub usage limits and terms.
