#!/usr/bin/env python3
"""Multi-workspace podcast worker.

Runs separately from the original single-account podcast workflow. It loads each
workspace's own feeds, provider keys, Spreaker show, schedule and ad slots.
Sensitive Supabase and provider credentials are read only from GitHub Actions
secrets and encrypted Supabase records; they are never printed.
"""
from __future__ import annotations

import base64
import json
from contextlib import redirect_stdout
import os
import shutil
import subprocess
import sys
import tempfile
import time as time_module
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


ROOT = Path(__file__).resolve().parent
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
# Prefer the legacy service_role JWT when explicitly configured; otherwise use the new sb_secret_* key.
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SECRET_KEY")
if not SUPABASE_SECRET_KEY:
    raise RuntimeError("Add SUPABASE_SECRET_KEY to GitHub Actions secrets.")
CREDENTIAL_ENCRYPTION_KEY = base64.b64decode(os.environ["CREDENTIAL_ENCRYPTION_KEY"])
WORKFLOW_WINDOW_HOURS = 1.5

KOKORO_ENGLISH_VOICES = frozenset({
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica",
    "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
})
DEFAULT_CUSTOMER_KOKORO_VOICE = "af_bella"
ADMIN_ONLY_KOKORO_VOICES = frozenset({"af_heart", "am_michael"})
PUBLISHING_INTERVAL_OPTIONS = frozenset({2, 4, 6, 8})
SCRIPT_FILES = [
    "fetch_news.py",
    "generate_script.py",
    "clean_script.py",
    "generate_metadata.py",
    "generate_audio.py",
    "upload_spreaker.py",
]


class SupabaseTransientError(RuntimeError):
    """A retryable Supabase HTTP response, such as 429 or 5xx."""


class SupabaseRest:
    RETRYABLE_METHODS = {"GET", "PATCH", "DELETE"}
    RETRYABLE_STATUSES = {408, 425, 429, 500, 502, 503, 504}

    def __init__(self) -> None:
        self.base = f"{SUPABASE_URL}/rest/v1"
        self.session = requests.Session()
        # Supabase's new sb_secret_* keys are opaque API keys, not JWTs.
        # Send them only as apikey. Legacy service_role keys are JWTs and
        # must also be sent as the Bearer token to select the service_role.
        self.session.headers.update({
            "apikey": SUPABASE_SECRET_KEY,
            "Content-Type": "application/json",
        })
        if not SUPABASE_SECRET_KEY.startswith("sb_secret_"):
            self.session.headers["Authorization"] = f"Bearer {SUPABASE_SECRET_KEY}"

    def request(self, method: str, table: str, *, params=None, body=None, prefer=None):
        method = method.upper()
        headers = {}
        if prefer:
            headers["Prefer"] = prefer
        retry_safe = method in self.RETRYABLE_METHODS

        for attempt in range(4):
            try:
                response = self.session.request(
                    method,
                    f"{self.base}/{table}",
                    params=params,
                    json=body,
                    headers=headers,
                    timeout=(20, 120),
                )
            except requests.exceptions.RequestException:
                if not retry_safe or attempt == 3:
                    raise
                delay = min(2 ** attempt, 8)
                print(
                    f"Supabase {method} {table} timed out; retrying in {delay}s "
                    f"(attempt {attempt + 2}/4).",
                    file=sys.stderr,
                    flush=True,
                )
                time_module.sleep(delay)
                continue

            if retry_safe and response.status_code in self.RETRYABLE_STATUSES and attempt < 3:
                retry_after = response.headers.get("Retry-After")
                try:
                    delay = min(max(int(retry_after), 1), 15) if retry_after else min(2 ** attempt, 8)
                except ValueError:
                    delay = min(2 ** attempt, 8)
                print(
                    f"Supabase {method} {table} returned HTTP {response.status_code}; "
                    f"retrying in {delay}s (attempt {attempt + 2}/4).",
                    file=sys.stderr,
                    flush=True,
                )
                time_module.sleep(delay)
                continue

            if not response.ok:
                message = (
                    f"Supabase {method} {table} failed with HTTP {response.status_code}: "
                    f"{response.text[:1200]}"
                )
                if response.status_code in self.RETRYABLE_STATUSES:
                    raise SupabaseTransientError(message)
                raise RuntimeError(message)
            if not response.text:
                return []
            try:
                return response.json()
            except ValueError:
                return []

        raise RuntimeError(f"Supabase {method} {table} failed after retry attempts.")

    def select(self, table: str, **params):
        return self.request("GET", table, params=params)

    def insert(self, table: str, body, *, params=None, prefer="return=representation"):
        return self.request("POST", table, params=params, body=body, prefer=prefer)

    def patch(self, table: str, params, body):
        return self.request("PATCH", table, params=params, body=body, prefer="return=representation")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def decrypt_record(row: dict[str, Any]) -> str:
    iv = base64.b64decode(row["iv"])
    ciphertext = base64.b64decode(row["ciphertext"])
    tag = base64.b64decode(row["auth_tag"])
    plaintext = AESGCM(CREDENTIAL_ENCRYPTION_KEY).decrypt(iv, ciphertext + tag, None)
    return plaintext.decode("utf-8")


def parse_spreaker_bundle(serialized: str) -> dict[str, Any]:
    try:
        item = json.loads(serialized)
        if isinstance(item, dict) and any(
            isinstance(item.get(key), str)
            for key in ("access_token", "client_id", "client_secret")
        ):
            return item
    except json.JSONDecodeError:
        pass
    # Backward compatibility with the earlier manually saved access-token field.
    return {"access_token": serialized}


def encrypt_bundle(bundle: dict[str, Any]) -> dict[str, str]:
    iv = os.urandom(12)
    encrypted = AESGCM(CREDENTIAL_ENCRYPTION_KEY).encrypt(
        iv, json.dumps(bundle, separators=(",", ":")).encode("utf-8"), None
    )
    return {
        "ciphertext": base64.b64encode(encrypted[:-16]).decode("ascii"),
        "iv": base64.b64encode(iv).decode("ascii"),
        "auth_tag": base64.b64encode(encrypted[-16:]).decode("ascii"),
        "key_version": "aes-256-gcm-v1",
        "updated_at": iso_utc(now_utc()),
    }


def load_credentials(db: SupabaseRest, owner_id: str) -> dict[str, str]:
    rows = db.select(
        "integration_credentials",
        select="provider,ciphertext,iv,auth_tag,key_version",
        owner_id=f"eq.{owner_id}",
    )
    credentials: dict[str, str] = {}
    for row in rows:
        provider = row.get("provider")
        if provider in {"spreaker", "groq", "gemini"}:
            credentials[provider] = decrypt_record(row)
    return credentials


def connected_providers(db: SupabaseRest, owner_id: str) -> set[str]:
    rows = db.select(
        "integration_connections",
        select="provider,status",
        owner_id=f"eq.{owner_id}",
    )
    return {
        str(row.get("provider"))
        for row in rows
        if row.get("status") == "connected"
    }


def usable_spreaker_token(db: SupabaseRest, owner_id: str, raw: str) -> tuple[str, dict[str, Any]]:
    bundle = parse_spreaker_bundle(raw)
    access_token = bundle.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise RuntimeError("Spreaker access token is missing.")

    expiry = bundle.get("expires_at")
    expires_soon = isinstance(expiry, (int, float)) and expiry <= int(now_utc().timestamp()) + 120
    if not expires_soon:
        return access_token, bundle

    refresh_token = bundle.get("refresh_token")
    client_id = bundle.get("client_id")
    client_secret = bundle.get("client_secret")
    if not refresh_token or not client_id or not client_secret:
        raise RuntimeError("The Spreaker token expired; reconnect this workspace's Spreaker account.")

    fields = {
        "grant_type": "refresh_token",
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
    }
    response = requests.post(
        "https://api.spreaker.com/oauth2/token",
        files={key: (None, value) for key, value in fields.items()},
        timeout=(20, 60),
    )
    payload = response.json() if response.content else {}
    tokens = payload.get("response", payload)
    if not response.ok or not isinstance(tokens.get("access_token"), str):
        raise RuntimeError("Spreaker could not refresh the account token. Reconnect the account.")

    expires_in = int(tokens.get("expires_in") or 0)
    bundle = {
        "client_id": client_id,
        "client_secret": client_secret,
        "access_token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token") or refresh_token,
        "token_type": tokens.get("token_type") or "Bearer",
        "scope": tokens.get("scope") or bundle.get("scope", "basic"),
        "expires_at": int(now_utc().timestamp()) + expires_in if expires_in > 0 else None,
    }
    encrypted = encrypt_bundle(bundle)
    db.patch(
        "integration_credentials",
        {"owner_id": f"eq.{owner_id}", "provider": "eq.spreaker"},
        encrypted,
    )
    db.patch(
        "integration_connections",
        {"owner_id": f"eq.{owner_id}", "provider": "eq.spreaker"},
        {
            "status": "connected",
            "masked_suffix": bundle["access_token"][-4:],
            "updated_at": iso_utc(now_utc()),
        },
    )
    return bundle["access_token"], bundle


def workspace_timezone(settings: dict[str, Any], workspace: dict[str, Any]) -> ZoneInfo:
    name = settings.get("timezone") or workspace.get("timezone") or "Africa/Nairobi"
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        print(f"Skipping workspace with invalid timezone: {name}", flush=True)
        return ZoneInfo("Africa/Nairobi")


def due_schedule_slot(settings: dict[str, Any], workspace: dict[str, Any], current: datetime):
    zone = workspace_timezone(settings, workspace)
    local_now = current.astimezone(zone)
    try:
        interval_hours = int(settings.get("publishing_interval_hours") or 8)
    except (TypeError, ValueError):
        interval_hours = 8
    if interval_hours not in PUBLISHING_INTERVAL_OPTIONS:
        interval_hours = 8

    candidates: list[datetime] = []
    for day in (local_now.date(), local_now.date() - timedelta(days=1)):
        for hour in range(0, 24, interval_hours):
            slot = datetime.combine(day, time(hour, 0), tzinfo=zone)
            delta = (current - slot.astimezone(timezone.utc)).total_seconds()
            if 0 <= delta <= WORKFLOW_WINDOW_HOURS * 3600:
                candidates.append(slot)
    if not candidates:
        return None
    return max(candidates).astimezone(timezone.utc)


def effective_workspace_plan(workspace: dict[str, Any], current: datetime | None = None) -> str:
    """Resolve an account's paid status from trusted subscription fields."""
    plan = str(workspace.get("plan") or "free")
    if plan == "admin":
        return "admin"
    if plan not in {"pro", "business"} or workspace.get("subscription_status") != "active":
        return "free"
    expiry_value = workspace.get("subscription_expires_at")
    if not expiry_value:
        return "free"
    try:
        expiry = datetime.fromisoformat(str(expiry_value).replace("Z", "+00:00"))
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return "free"
    now = current or now_utc()
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return "pro" if expiry > now else "free"


def daily_episode_count(db: SupabaseRest, owner_id: str, settings: dict[str, Any], workspace: dict[str, Any], current: datetime) -> int:
    zone = workspace_timezone(settings, workspace)
    local_midnight = datetime.combine(current.astimezone(zone).date(), time.min, tzinfo=zone)
    rows = db.select(
        "episodes",
        select="id",
        owner_id=f"eq.{owner_id}",
        created_at=f"gte.{iso_utc(local_midnight)}",
        status="in.(draft,queued,processing,ready,published)",
        limit="1000",
    )
    return len(rows)


def rolling_episode_count(db: SupabaseRest, owner_id: str, current: datetime) -> int:
    """Count active/successful episodes in the previous 30 days."""
    rows = db.select(
        "episodes",
        select="id",
        owner_id=f"eq.{owner_id}",
        created_at=f"gte.{iso_utc(current - timedelta(days=30))}",
        status="in.(draft,queued,processing,ready,published)",
        limit="1000",
    )
    return len(rows)


def has_lifetime_episode(db: SupabaseRest, owner_id: str) -> bool:
    """Return whether this workspace already has a non-failed episode."""
    rows = db.select(
        "episodes",
        select="id",
        owner_id=f"eq.{owner_id}",
        status="in.(draft,queued,processing,ready,published)",
        limit="1",
    )
    return bool(rows)


def workspace_episode_limits(workspace: dict[str, Any], workspace_plan: str) -> tuple[int, int]:
    """Return daily and rolling 30-day limits with plan-aware safe defaults."""
    if workspace_plan == "free":
        return 1, 1
    default_daily_limit = 6
    default_monthly_limit = 180
    daily_limit = max(1, int(workspace.get("daily_episode_limit") or default_daily_limit))
    monthly_limit = max(1, int(workspace.get("monthly_episode_limit") or default_monthly_limit))
    return daily_limit, monthly_limit


def covered_history(db: SupabaseRest, owner_id: str) -> dict[str, list[str]]:
    rows = db.select(
        "episodes",
        select="source_data",
        owner_id=f"eq.{owner_id}",
        order="created_at.desc",
        limit="1000",
    )
    history = {"story_ids": [], "urls": [], "titles": []}
    for row in rows:
        source = row.get("source_data") or {}
        if isinstance(source, str):
            try:
                source = json.loads(source)
            except json.JSONDecodeError:
                source = {}
        if not isinstance(source, dict):
            continue
        for field, key in (("story_id", "story_ids"), ("url", "urls"), ("title", "titles")):
            value = source.get(field)
            if value:
                history[key].append(str(value))
    return history


def workspace_feeds(db: SupabaseRest, owner_id: str) -> list[dict[str, str]]:
    rows = db.select(
        "news_feeds",
        select="name,feed_url,sport,league",
        owner_id=f"eq.{owner_id}",
        enabled="eq.true",
        order="name.asc",
        limit="500",
    )
    return [
        {"name": row["name"], "url": row["feed_url"]}
        for row in rows
        if row.get("name") and row.get("feed_url", "").startswith("https://")
    ]


def workspace_ad_slots(db: SupabaseRest, owner_id: str) -> list[dict[str, int]]:
    """Load all enabled cuepoints for a workspace, paging past the REST row limit."""
    rows: list[dict[str, Any]] = []
    page_size = 100
    offset = 0

    while True:
        page = db.select(
            "ad_slots",
            select="position_seconds,ads_max_count",
            owner_id=f"eq.{owner_id}",
            enabled="eq.true",
            order="position_seconds.asc",
            limit=str(page_size),
            offset=str(offset),
        )
        rows.extend(page)
        if len(page) < page_size:
            break
        offset += len(page)

    return [
        {
            "timecode": int(row["position_seconds"]) * 1000,
            "ads_max_count": max(1, min(4, int(row.get("ads_max_count") or 4))),
        }
        for row in rows
        if int(row.get("position_seconds") or 0) > 0
    ]


def mark_job(db: SupabaseRest, job_id: str, status: str, error: str | None = None):
    patch = {"status": status, "updated_at": iso_utc(now_utc()), "last_error": error[:2000] if error else None}
    db.patch("publishing_jobs", {"id": f"eq.{job_id}"}, patch)


def find_episode_for_worker_job(db: SupabaseRest, owner_id: str, job_id: str):
    return db.select(
        "episodes",
        select="id,spreaker_episode_id",
        owner_id=f"eq.{owner_id}",
        **{"source_data->>worker_job_id": f"eq.{job_id}"},
        limit="1",
    )


def save_worker_episode(db: SupabaseRest, episode: dict[str, Any], job_id: str) -> None:
    """Idempotently save an episode and resolve ambiguous POST timeouts by job ID."""
    owner_id = episode["owner_id"]
    for attempt in range(4):
        existing = find_episode_for_worker_job(db, owner_id, job_id)
        if existing:
            db.patch(
                "episodes",
                {"id": f"eq.{existing[0]['id']}", "owner_id": f"eq.{owner_id}"},
                {key: value for key, value in episode.items() if key != "owner_id"},
            )
            return

        try:
            db.insert("episodes", episode)
            return
        except (requests.exceptions.RequestException, SupabaseTransientError):
            # A response timeout can happen after Postgres committed the row.
            # Always check by job ID before repeating the insert.
            existing = find_episode_for_worker_job(db, owner_id, job_id)
            if existing:
                db.patch(
                    "episodes",
                    {"id": f"eq.{existing[0]['id']}", "owner_id": f"eq.{owner_id}"},
                    {key: value for key, value in episode.items() if key != "owner_id"},
                )
                return
            if attempt == 3:
                raise
            delay = min(2 ** attempt, 8)
            print(
                f"Episode save response was uncertain; no row is visible yet. "
                f"Retrying safely in {delay}s.",
                file=sys.stderr,
                flush=True,
            )
            time_module.sleep(delay)


def checkpoint_published_episode(
    db: SupabaseRest,
    job_id: str,
    job_payload: dict[str, Any],
    episode: dict[str, Any],
) -> dict[str, Any]:
    """Persist the confirmed Spreaker result before writing the Episodes row."""
    payload = dict(job_payload or {})
    payload.update({
        "worker_stage": "spreaker_published" if episode["status"] == "published" else "spreaker_review_ready",
        "recovery_episode": episode,
    })
    db.patch(
        "publishing_jobs",
        {"id": f"eq.{job_id}"},
        {"payload": payload, "updated_at": iso_utc(now_utc())},
    )
    return payload


def create_schedule_job(db: SupabaseRest, owner_id: str, slot: datetime) -> None:
    db.insert(
        "publishing_jobs",
        {
            "owner_id": owner_id,
            "job_type": "generate_episode",
            "status": "queued",
            "scheduled_at": iso_utc(slot),
            "payload": {"source": "workspace_schedule", "scheduled_slot": iso_utc(slot)},
        },
        params={"on_conflict": "owner_id,job_type,scheduled_at"},
        prefer="resolution=ignore-duplicates,return=representation",
    )


PLATFORM_SECRET_ENV_VARS = (
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CREDENTIAL_ENCRYPTION_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SPREAKER_CLIENT_ID",
    "SPREAKER_CLIENT_SECRET",
    "SPREAKER_ACCESS_TOKEN",
    "SPREAKER_SHOW_ID",
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
)


def workspace_feeds_for_plan(feeds: list[dict[str, str]], workspace_plan: str) -> list[dict[str, str]]:
    """Free accounts may use only the first two saved RSS feeds."""
    return feeds[:2] if workspace_plan == "free" else feeds


def workspace_kokoro_voice(settings: dict[str, Any], workspace_plan: str) -> str:
    voice = str(settings.get("tts_voice") or DEFAULT_CUSTOMER_KOKORO_VOICE)
    if workspace_plan == "free":
        return DEFAULT_CUSTOMER_KOKORO_VOICE
    if voice not in KOKORO_ENGLISH_VOICES:
        return DEFAULT_CUSTOMER_KOKORO_VOICE
    if workspace_plan != "admin" and voice in ADMIN_ONLY_KOKORO_VOICES:
        return DEFAULT_CUSTOMER_KOKORO_VOICE
    return voice


def build_workspace_process_env(
    base_env: dict[str, str],
    *,
    settings: dict[str, Any],
    workspace_plan: str = "free",
    groq_key: str,
    gemini_key: str,
    verified_providers: set[str],
    spreaker_token: str,
    show_id: str,
    ad_slots: list[dict[str, int]],
) -> dict[str, str]:
    """Build a subprocess environment using only this workspace's provider credentials."""
    env = dict(base_env)
    for name in PLATFORM_SECRET_ENV_VARS:
        env.pop(name, None)
    # Do not allow an Actions-level environment variable to override the
    # fixed platform writing policy.
    env.pop("AI_WRITING_INSTRUCTIONS", None)

    # Match the existing single-account automation for every workspace:
    # Groq is primary; a separately verified Gemini key is the fallback.
    groq_for_run = groq_key if "groq" in verified_providers else ""
    gemini_for_run = gemini_key if "gemini" in verified_providers else ""

    env.update({
        "GROQ_API_KEY": groq_for_run,
        "GEMINI_API_KEY": gemini_for_run,
        "GROQ_TEXT_MODEL": "openai/gpt-oss-120b",
        "GEMINI_TEXT_MODEL": "gemini-3.5-flash-lite",
        "PODCAST_NAME": str(settings.get("podcast_name") or "Sports News Podcast"),
        "PODCAST_DESCRIPTION": str(settings.get("podcast_description") or ""),
        "PODCAST_CATEGORY": str(settings.get("category") or "Sports"),
        "PODCAST_LANGUAGE": str(settings.get("language") or "en"),
        "PODCAST_COUNTRY": str(settings.get("country") or "KE"),
        "SPREAKER_ACCESS_TOKEN": spreaker_token,
        "SPREAKER_SHOW_ID": show_id,
        "KOKORO_VOICE": workspace_kokoro_voice(settings, workspace_plan),
        "PUBLISHING_MODE": str(settings.get("publishing_mode") or "automatic"),
        "AD_CUEPOINTS_JSON": json.dumps(ad_slots),
        "KOKORO_TORCH_THREADS": "4",
        "OMP_NUM_THREADS": "4",
        "MKL_NUM_THREADS": "4",
        "OPENBLAS_NUM_THREADS": "4",
    })
    return env


def run_pipeline(
    db: SupabaseRest,
    owner_id: str,
    settings: dict[str, Any],
    workspace: dict[str, Any],
    job_id: str,
    job_payload: dict[str, Any],
) -> None:
    credentials = load_credentials(db, owner_id)
    verified = connected_providers(db, owner_id)
    if "spreaker" not in verified or not credentials.get("spreaker"):
        raise RuntimeError("Connect and verify Spreaker in API Connections before enabling automation.")
    show_id = (settings.get("spreaker_show_id") or "").strip()
    if not show_id:
        raise RuntimeError("Choose a Spreaker show in API Connections before enabling automation.")

    groq_key = credentials.get("groq", "")
    gemini_key = credentials.get("gemini", "")
    if not (("groq" in verified and groq_key) or ("gemini" in verified and gemini_key)):
        raise RuntimeError("Connect and verify your own Groq or Gemini API key in API Connections before enabling automation.")

    workspace_plan = effective_workspace_plan(workspace, now_utc())
    spreaker_token, _ = usable_spreaker_token(db, owner_id, credentials["spreaker"])
    feeds = workspace_feeds_for_plan(workspace_feeds(db, owner_id), workspace_plan)
    if not feeds:
        raise RuntimeError("Add and enable at least one sports news feed.")
    ad_slots = workspace_ad_slots(db, owner_id)

    history = covered_history(db, owner_id)
    maximum_narration_characters = 5000 if workspace_plan == "free" else 50000
    minimum_narration_characters = int(settings.get("minimum_narration_characters") or 13500)
    minimum_narration_characters = min(max(5000, minimum_narration_characters), maximum_narration_characters)

    config = {
        "rss_feeds": feeds,
        "max_story_age_hours": 24,
        "minimum_narration_characters": minimum_narration_characters,
        "maximum_narration_characters": maximum_narration_characters,
        "tts_enabled": True,
        "timezone": settings.get("timezone") or workspace.get("timezone") or "Africa/Nairobi",
        "max_episodes_per_run": 1,
        "skip_previously_covered_stories": True,
    }

    with tempfile.TemporaryDirectory(prefix=f"podcast-{owner_id[:8]}-") as temp:
        workdir = Path(temp)
        for filename in SCRIPT_FILES:
            shutil.copy2(ROOT / filename, workdir / filename)
        (workdir / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
        (workdir / "covered_stories.json").write_text(json.dumps(history, ensure_ascii=False), encoding="utf-8")

        # Only this workspace's verified provider credentials enter the pipeline.
        env = build_workspace_process_env(
            os.environ,
            settings=settings,
            workspace_plan=workspace_plan,
            groq_key=groq_key,
            gemini_key=gemini_key,
            verified_providers=verified,
            spreaker_token=spreaker_token,
            show_id=show_id,
            ad_slots=ad_slots,
        )

        for filename in SCRIPT_FILES:
            print(f"[{owner_id}] Running {filename}", flush=True)
            subprocess.run(
                [sys.executable, filename],
                cwd=workdir,
                env=env,
                check=True,
                timeout=165 * 60,
            )

        story_path = workdir / "output" / "selected_story.json"
        metadata_path = workdir / "output" / "episode" / "youtube_metadata.json"
        result_path = workdir / "output" / "episode" / "spreaker_upload.json"
        if not story_path.exists() or not metadata_path.exists() or not result_path.exists():
            raise RuntimeError("Episode pipeline ended without all required output records.")

        story = json.loads(story_path.read_text(encoding="utf-8"))
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        result = json.loads(result_path.read_text(encoding="utf-8"))
        result_status = result.get("status")
        if result_status not in {"published", "review_required"}:
            raise RuntimeError(f"Spreaker upload did not finish successfully (status: {result_status}).")

        published = result_status == "published"
        source_data = {
            "story_id": story.get("story_id"),
            "url": story.get("url"),
            "title": story.get("title"),
            "source": story.get("source"),
            "published_at": story.get("published_at"),
            "worker_job_id": job_id,
            "spreaker_status": result_status,
            "advertising_markers": result.get("details", {}).get("advertising_markers", {}),
        }
        episode = {
            "owner_id": owner_id,
            "title": metadata.get("title") or story.get("title") or "Sports news episode",
            "description": metadata.get("description") or "",
            "status": "published" if published else "draft",
            "spreaker_episode_id": str(result.get("episode_id") or ""),
            "source_data": source_data,
            "generated_at": iso_utc(now_utc()),
            "published_at": iso_utc(now_utc()) if published else None,
            "updated_at": iso_utc(now_utc()),
        }
        # Spreaker has already accepted the upload/publish request. Record
        # a recovery checkpoint on the job before saving the Episodes row.
        # If Supabase times out while writing the episode, the next worker run
        # can finish the database save without generating or publishing again.
        saved_payload = checkpoint_published_episode(db, job_id, job_payload, episode)
        job_payload.clear()
        job_payload.update(saved_payload)
        save_worker_episode(db, episode, job_id)
        print(f"[{owner_id}] Episode completed: {episode['title']} ({episode['status']})", flush=True)


def process_publish_job(db: SupabaseRest, job: dict[str, Any]) -> None:
    owner_id = job["owner_id"]
    payload = job.get("payload") or {}
    episode_id = payload.get("episode_id")
    if not episode_id:
        raise RuntimeError("Publish job is missing episode_id.")

    episode_rows = db.select(
        "episodes",
        select="id,status,spreaker_episode_id",
        id=f"eq.{episode_id}",
        owner_id=f"eq.{owner_id}",
        limit="1",
    )
    if not episode_rows:
        raise RuntimeError("The episode does not belong to this workspace.")
    episode = episode_rows[0]
    if episode.get("status") == "published":
        return
    if episode.get("status") not in {"draft", "queued"}:
        raise RuntimeError("Only an unpublished draft can be published.")
    spreaker_episode_id = episode.get("spreaker_episode_id")
    if not spreaker_episode_id:
        raise RuntimeError("The episode is missing its Spreaker episode ID.")

    credentials = load_credentials(db, owner_id)
    if "spreaker" not in connected_providers(db, owner_id) or not credentials.get("spreaker"):
        raise RuntimeError("Connect and verify Spreaker again before publishing this episode.")
    token, _ = usable_spreaker_token(db, owner_id, credentials["spreaker"])
    published_at = now_utc().strftime("%Y-%m-%d %H:%M:%S")
    response = requests.post(
        f"https://api.spreaker.com/v2/episodes/{spreaker_episode_id}",
        headers={"Authorization": f"Bearer {token}"},
        data={"published_at": published_at},
        timeout=(20, 120),
    )
    if not response.ok:
        raise RuntimeError(f"Spreaker refused to publish the episode (HTTP {response.status_code}).")

    db.patch(
        "episodes",
        {"id": f"eq.{episode_id}", "owner_id": f"eq.{owner_id}"},
        {"status": "published", "published_at": iso_utc(now_utc()), "updated_at": iso_utc(now_utc())},
    )


def process_queued_jobs(db: SupabaseRest):
    pending = db.select(
        "publishing_jobs",
        select="id,owner_id,job_type,status,payload",
        status="in.(queued,processing)",
        order="created_at.asc",
        limit="20",
    )
    for job in pending:
        job_id = job["id"]
        owner_id = job["owner_id"]
        payload = job.get("payload") if isinstance(job.get("payload"), dict) else {}
        recovery_episode = payload.get("recovery_episode")
        recovery_stage = payload.get("worker_stage") in {"spreaker_published", "spreaker_review_ready"}
        is_recovery = recovery_stage and isinstance(recovery_episode, dict)

        # Only recover processing jobs that have a durable post-Spreaker
        # checkpoint. Other processing jobs may still belong to an active run.
        if job.get("status") == "processing" and not is_recovery:
            continue

        if job.get("status") == "queued":
            claimed = db.patch(
                "publishing_jobs",
                {"id": f"eq.{job_id}", "status": "eq.queued"},
                {"status": "processing", "updated_at": iso_utc(now_utc())},
            )
            if not claimed:
                continue

        try:
            if is_recovery:
                print(
                    f"[{owner_id}] Recovering the saved Spreaker result for job {job_id}; "
                    "the podcast will not be generated or uploaded again.",
                    flush=True,
                )
                save_worker_episode(db, recovery_episode, job_id)
                mark_job(db, job_id, "completed")
                print(
                    f"[{owner_id}] Recovered published episode {recovery_episode.get('spreaker_episode_id')}.",
                    flush=True,
                )
                continue

            if job["job_type"] == "publish_episode":
                process_publish_job(db, job)
            elif job["job_type"] == "generate_episode":
                workspace_rows = db.select(
                    "workspaces",
                    select="owner_id,plan,daily_episode_limit,monthly_episode_limit,subscription_status,subscription_expires_at,timezone",
                    owner_id=f"eq.{owner_id}",
                    limit="1",
                )
                settings_rows = db.select(
                    "workspace_settings",
                    select="*",
                    owner_id=f"eq.{owner_id}",
                    limit="1",
                )
                if not workspace_rows or not settings_rows:
                    raise RuntimeError("Workspace settings were not found.")
                workspace, settings = workspace_rows[0], settings_rows[0]
                current = now_utc()
                plan = effective_workspace_plan(workspace, current)
                is_manual = payload.get("source") == "manual"

                if plan == "free" and has_lifetime_episode(db, owner_id):
                    mark_job(db, job_id, "cancelled", "The one free lifetime episode has already been used. Upgrade to continue.")
                    print(f"[{owner_id}] Cancelled job {job_id}: the one free lifetime episode was already used.", flush=True)
                    continue

                if not is_manual and plan not in {"pro", "admin"}:
                    mark_job(db, job_id, "cancelled", "Scheduled automation requires an active paid subscription.")
                    print(f"[{owner_id}] Cancelled scheduled job {job_id}: no active paid plan.", flush=True)
                    continue

                if plan != "admin":
                    limit, monthly_limit = workspace_episode_limits(workspace, plan)
                    used_today = daily_episode_count(db, owner_id, settings, workspace, current)
                    if used_today >= limit:
                        mark_job(db, job_id, "cancelled", f"Daily episode allowance reached ({used_today}/{limit}).")
                        print(f"[{owner_id}] Cancelled queued job {job_id}: daily episode allowance reached ({used_today}/{limit}).", flush=True)
                        continue

                    used_30_days = rolling_episode_count(db, owner_id, current)
                    if used_30_days >= monthly_limit:
                        mark_job(db, job_id, "cancelled", f"Rolling 30-day episode allowance reached ({used_30_days}/{monthly_limit}).")
                        print(f"[{owner_id}] Cancelled queued job {job_id}: 30-day episode allowance reached ({used_30_days}/{monthly_limit}).", flush=True)
                        continue

                run_pipeline(db, owner_id, settings, workspace, job_id, payload)
            else:
                raise RuntimeError("Unsupported publishing job type.")
            mark_job(db, job_id, "completed")
        except Exception as exc:
            print(f"Job {job_id} failed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            # If Spreaker has confirmed an episode, never mark the job failed
            # or re-run generation. Re-queue the checkpoint for DB-only recovery.
            if payload.get("worker_stage") in {"spreaker_published", "spreaker_review_ready"} and isinstance(payload.get("recovery_episode"), dict):
                mark_job(
                    db,
                    job_id,
                    "queued",
                    f"Spreaker completed the episode; database finalization will be retried: {exc}",
                )
                print(
                    f"[{owner_id}] Spreaker succeeded; job {job_id} queued for database-only recovery.",
                    flush=True,
                )
                continue

            # If the checkpoint update may have timed out after Postgres committed it,
            # read the job before deciding whether this was a real generation failure.
            try:
                current = db.select(
                    "publishing_jobs",
                    select="payload",
                    id=f"eq.{job_id}",
                    limit="1",
                )
                current_payload = current[0].get("payload") if current and isinstance(current[0].get("payload"), dict) else {}
            except Exception:
                current_payload = {}

            if current_payload.get("worker_stage") in {"spreaker_published", "spreaker_review_ready"} and isinstance(current_payload.get("recovery_episode"), dict):
                mark_job(
                    db,
                    job_id,
                    "queued",
                    f"Spreaker completed the episode; database finalization will be retried: {exc}",
                )
                print(
                    f"[{owner_id}] Spreaker checkpoint recovered after a database response error; job queued for finalization.",
                    flush=True,
                )
                continue

            mark_job(db, job_id, "failed", str(exc))
            if job.get("job_type") == "generate_episode":
                failure_episode = {
                    "owner_id": owner_id,
                    "title": "Episode generation failed",
                    "description": str(exc)[:1000],
                    "status": "failed",
                    "source_data": {"worker_job_id": job_id},
                }
                try:
                    save_worker_episode(db, failure_episode, job_id)
                except Exception as save_error:
                    print(
                        f"Could not save failure detail for job {job_id}: {type(save_error).__name__}: {save_error}",
                        file=sys.stderr,
                        flush=True,
                    )


def enqueue_due_workspaces(db: SupabaseRest):
    current = now_utc()
    workspaces = db.select(
        "workspaces",
        select="owner_id,plan,daily_episode_limit,monthly_episode_limit,subscription_status,subscription_expires_at,timezone",
        limit="1000",
    )
    for workspace in workspaces:
        owner_id = workspace.get("owner_id")
        if not owner_id:
            continue
        settings_rows = db.select(
            "workspace_settings",
            select="*",
            owner_id=f"eq.{owner_id}",
            limit="1",
        )
        if not settings_rows:
            continue
        settings = settings_rows[0]
        plan = effective_workspace_plan(workspace, current)
        # Free workspaces can use one lifetime episode but never receive
        # recurring jobs, even if an older settings row still says enabled.
        if plan not in {"pro", "admin"} or not settings.get("automation_enabled", False):
            continue
        due_slot = due_schedule_slot(settings, workspace, current)
        if due_slot is None:
            continue
        if plan != "admin":
            limit = max(1, int(workspace.get("daily_episode_limit") or 6))
            used_today = daily_episode_count(db, owner_id, settings, workspace, current)
            used_30_days = rolling_episode_count(db, owner_id, current)
            monthly_limit = max(1, int(workspace.get("monthly_episode_limit") or 180))
            if used_today >= limit:
                print(f"[{owner_id}] Daily episode limit reached ({used_today}/{limit}); skipping.", flush=True)
                continue
            if used_30_days >= monthly_limit:
                print(f"[{owner_id}] Rolling 30-day episode limit reached ({used_30_days}/{monthly_limit}); skipping.", flush=True)
                continue
        create_schedule_job(db, owner_id, due_slot)
        print(f"[{owner_id}] Scheduled generation job for {iso_utc(due_slot)}.", flush=True)


def check_pending_work() -> bool:
    """Enqueue due scheduled slots, then report whether the worker has queued jobs."""
    if len(CREDENTIAL_ENCRYPTION_KEY) != 32:
        raise RuntimeError("CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes.")
    db = SupabaseRest()
    enqueue_due_workspaces(db)
    queued = db.select(
        "publishing_jobs",
        select="id",
        status="eq.queued",
        limit="1",
    )
    if queued:
        return True

    # A runner can be interrupted after Spreaker publishes and after the
    # recovery checkpoint is saved but before the Episodes row is finalized.
    # Keep these jobs visible to the lightweight poller for DB-only recovery.
    recoverable = db.select(
        "publishing_jobs",
        select="id",
        status="eq.processing",
        **{"payload->>worker_stage": "in.(spreaker_published,spreaker_review_ready)"},
        limit="1",
    )
    return bool(recoverable)


def report_pending_work_status() -> None:
    """Print only the boolean consumed by GitHub Actions; keep diagnostics on stderr."""
    # The scheduled-slot scan may log newly created jobs. Those messages must
    # not be mixed with the machine-readable value written to GITHUB_OUTPUT.
    with redirect_stdout(sys.stderr):
        has_work = check_pending_work()
    print("true" if has_work else "false", flush=True)


def main():
    if len(CREDENTIAL_ENCRYPTION_KEY) != 32:
        raise RuntimeError("CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes.")
    db = SupabaseRest()
    enqueue_due_workspaces(db)
    process_queued_jobs(db)
    print("Multi-workspace podcast worker finished.", flush=True)


if __name__ == "__main__":
    try:
        if "--check-pending" in sys.argv:
            report_pending_work_status()
        else:
            main()
    except Exception as exc:
        print(f"FATAL: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
