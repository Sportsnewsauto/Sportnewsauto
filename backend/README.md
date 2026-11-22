# Automate Spreaker Podcast API

Initial FastAPI service scaffold.

## Run locally

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

On Windows PowerShell, activate the environment with:

```powershell
.venv\Scripts\Activate.ps1
```

Health check: http://127.0.0.1:8000/health  
API documentation: http://127.0.0.1:8000/docs

## Current status

Only health and API-root endpoints exist. There is no registration, login, database, API-key storage, billing, job dispatch or publishing endpoint yet.

## Planned backend modules

- Authentication and account sessions.
- User-owned integration credentials, encrypted at rest.
- Podcast show and RSS-feed settings.
- Plan entitlements and daily episode quotas.
- Episode records and approval workflow.
- Secure job dispatch to GitHub Actions.
- Spreaker publishing adapter.
- Platform-hosted Podcasti audio service.

Every user-scoped query and background job must enforce ownership on the server. Never trust a user ID supplied by the browser without validating it against the authenticated session.
