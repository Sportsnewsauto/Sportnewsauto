from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.settings import settings

app = FastAPI(
    title="Automate Spreaker Podcast API",
    version="0.1.0",
    description="Private API for podcast accounts, integrations and automation jobs.",
)

if settings.allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )


@app.get("/health", tags=["system"])
async def health_check() -> dict[str, str]:
    """Basic process health check; does not expose configuration or secrets."""
    return {"status": "ok", "service": "automate-spreaker-podcast-api"}


@app.get("/api/v1", tags=["system"])
async def api_root() -> dict[str, str]:
    return {"name": "Automate Spreaker Podcast API", "version": "v1"}
