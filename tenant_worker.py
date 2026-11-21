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
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


ROOT = Path(__file__).resolve().parent
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_SECRET_KEY:
    raise RuntimeError("Add SUPABASE_SECRET_KEY to GitHub Actions secrets.")
CREDENTIAL_ENCRYPTION_KEY = base64.b64decode(os.environ["CREDENTIAL_ENCRYPTION_KEY"])
SPREAKER_CLIENT_ID = os.getenv("SPREAKER_CLIENT_ID", "")
SPREAKER_CLIENT_SECRET = os.getenv("SPREAKER_CLIENT_SECRET", "")
WORKFLOW_WINDOW_HOURS = 3.5
SCRIPT_FILES = [
    "fetch_news.py",
    "generate_script.py",
    "clean_script.py",
    "generate_metadata.py",
    "generate_audio.py",
    "upload_spreaker.py",
]


class SupabaseRest:
    def __init__(self) -> None:
        self.base = f"{SUPABASE_URL}/rest/v1"
        self.session = requests.Session()
        self.session.headers.update({
            "apikey": SUPABASE_SECRET_KEY,
            "Authorization": f"Bearer {SUPABASE_SECRET_KEY}",
            "Content-Type": "application/json",
        })

    def request(self, method: str, table: str, *, params=None, body=None, prefer=None):
        headers = {}
        if prefer:
            headers["Prefer"] = prefer
        response = self.session.request(
            method,
            f"{self.base}/{table}",
            params=params,
            json=body,
            headers=headers,
            timeout=(20, 120),
        )
        if not response.ok:
            raise RuntimeError(
                f"Supabase {method} {table} failed with HTTP {response.status_code}: "
                f"{response.text[:1200]}"
            )
        if not response.text:
            return []
        try:
            return response.json()
        except ValueError:
            return []

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
        if isinstance(item, dict) and isinstance(item.get("access_token"), str):
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
    if not refresh_token or not SPREAKER_CLIENT_ID or not SPREAKER_CLIENT_SECRET:
        raise RuntimeError("The Spreaker token expired; reconnect this workspace's Spreaker account.")

    fields = {
        "grant_type": "refresh_token",
        "client_id": SPREAKER_CLIENT_ID,
        "client_secret": SPREAKER_CLIENT_SECRET,
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
    times = settings.get("scheduled_times") or []
    if not isinstance(times, list):
        return None

    candidates: list[datetime] = []
    for day in (local_now.date(), local_now.date() - timedelta(days=1)):
        for value in times:
            if not isinstance(value, str):
                continue
            try:
                hour, minute = (int(part) for part in value.split(":", 1))
                if not 0 <= hour <= 23 or not 0 <= minute <= 59:
                    continue
                slot = datetime.combine(day, time(hour, minute), tzinfo=zone)
                delta = (current - slot.astimezone(timezone.utc)).total_seconds()
                if 0 <= delta <= WORKFLOW_WINDOW_HOURS * 3600:
                    candidates.append(slot)
            except (ValueError, TypeError):
                continue
    if not candidates:
        return None
    return max(candidates).astimezone(timezone.utc)


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
    rows = db.select(
        "ad_slots",
        select="position_seconds,ads_max_count",
        owner_id=f"eq.{owner_id}",
        enabled="eq.true",
        order="position_seconds.asc",
        limit="100",
    )
    return [
        {
            "timecode": int(row["position_seconds"]) * 1000,
            "ads_max_count": max(1, min(4, int(row.get("ads_max_count") or 4))),
        }
        for row in rows
        if int(row.get("position_seconds") or 0) > 0
    ]


def mark_job(db: SupabaseRest, job_id: str, status: str, error: str | None = None):
    patch = {"status": status, "updated_at": iso_utc(now_utc())}
    if error:
        patch["last_error"] = error[:2000]
    db.patch("publishing_jobs", {"id": f"eq.{job_id}"}, patch)


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


def run_pipeline(
    db: SupabaseRest,
    owner_id: str,
    settings: dict[str, Any],
    workspace: dict[str, Any],
    job_id: str,
) -> None:
    credentials = load_credentials(db, owner_id)
    verified = connected_providers(db, owner_id)
    if "spreaker" not in verified or not credentials.get("spreaker"):
        raise RuntimeError("Connect and verify Spreaker in API Connections before enabling automation.")
    show_id = (settings.get("spreaker_show_id") or "").strip()
    if not show_id:
        raise RuntimeError("Choose a Spreaker show in API Connections before enabling automation.")

    selected_ai = settings.get("ai_provider") or "groq"
    groq_key = credentials.get("groq", "")
    gemini_key = credentials.get("gemini", "")
    if selected_ai == "gemini":
        if "gemini" not in verified or not gemini_key:
            raise RuntimeError("Gemini is selected, but its API key is not connected and verified.")
        groq_for_run = ""
    else:
        if "groq" not in verified or not groq_key:
            raise RuntimeError("Groq is selected, but its API key is not connected and verified.")
        groq_for_run = groq_key

    spreaker_token, _ = usable_spreaker_token(db, owner_id, credentials["spreaker"])
    feeds = workspace_feeds(db, owner_id)
    if not feeds:
        raise RuntimeError("Add and enable at least one sports news feed.")
    ad_slots = workspace_ad_slots(db, owner_id)

    history = covered_history(db, owner_id)
    config = {
        "rss_feeds": feeds,
        "max_story_age_hours": 24,
        "minimum_narration_characters": 13500,
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

        env = os.environ.copy()
        env.update({
            "GROQ_API_KEY": groq_for_run,
            "GEMINI_API_KEY": gemini_key,
            "GROQ_TEXT_MODEL": settings.get("ai_model") if selected_ai == "groq" else "openai/gpt-oss-120b",
            "GEMINI_TEXT_MODEL": settings.get("ai_model") if selected_ai == "gemini" else "gemini-3.5-flash-lite",
            "PODCAST_NAME": settings.get("podcast_name") or "Sports News Podcast",
            "PODCAST_DESCRIPTION": settings.get("podcast_description") or "",
            "PODCAST_CATEGORY": settings.get("category") or "Sports",
            "PODCAST_LANGUAGE": settings.get("language") or "en",
            "PODCAST_COUNTRY": settings.get("country") or "KE",
            "AI_WRITING_INSTRUCTIONS": settings.get("ai_writing_instructions") or "",
            "SPREAKER_ACCESS_TOKEN": spreaker_token,
            "SPREAKER_SHOW_ID": show_id,
            "KOKORO_VOICE": settings.get("tts_voice") or "af_heart",
            "PUBLISHING_MODE": settings.get("publishing_mode") or "automatic",
            "AD_CUEPOINTS_JSON": json.dumps(ad_slots),
            "KOKORO_TORCH_THREADS": "4",
            "OMP_NUM_THREADS": "4",
            "MKL_NUM_THREADS": "4",
            "OPENBLAS_NUM_THREADS": "4",
        })

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
        db.insert("episodes", episode)
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
    queued = db.select(
        "publishing_jobs",
        select="id,owner_id,job_type,status,payload",
        status="eq.queued",
        order="created_at.asc",
        limit="20",
    )
    for job in queued:
        job_id = job["id"]
        claimed = db.patch(
            "publishing_jobs",
            {"id": f"eq.{job_id}", "status": "eq.queued"},
            {"status": "processing", "updated_at": iso_utc(now_utc())},
        )
        if not claimed:
            continue
        try:
            owner_id = job["owner_id"]
            if job["job_type"] == "publish_episode":
                process_publish_job(db, job)
            elif job["job_type"] == "generate_episode":
                workspace_rows = db.select(
                    "workspaces",
                    select="owner_id,plan,daily_episode_limit,timezone",
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
                run_pipeline(db, owner_id, settings, workspace, job_id)
            else:
                raise RuntimeError("Unsupported publishing job type.")
            mark_job(db, job_id, "completed")
        except Exception as exc:
            print(f"Job {job_id} failed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            mark_job(db, job_id, "failed", str(exc))
            if job.get("job_type") == "generate_episode":
                db.insert("episodes", {
                    "owner_id": job["owner_id"],
                    "title": "Episode generation failed",
                    "description": str(exc)[:1000],
                    "status": "failed",
                    "source_data": {"worker_job_id": job_id},
                })


def enqueue_due_workspaces(db: SupabaseRest):
    current = now_utc()
    workspaces = db.select(
        "workspaces",
        select="owner_id,plan,daily_episode_limit,timezone",
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
        if not settings.get("automation_enabled", False):
            continue
        due_slot = due_schedule_slot(settings, workspace, current)
        if due_slot is None:
            continue
        limit = max(1, int(workspace.get("daily_episode_limit") or 1))
        used = daily_episode_count(db, owner_id, settings, workspace, current)
        if used >= limit:
            print(f"[{owner_id}] Daily episode limit reached ({used}/{limit}); skipping.", flush=True)
            continue
        create_schedule_job(db, owner_id, due_slot)
        print(f"[{owner_id}] Scheduled generation job for {iso_utc(due_slot)}.", flush=True)


def main():
    if len(CREDENTIAL_ENCRYPTION_KEY) != 32:
        raise RuntimeError("CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes.")
    db = SupabaseRest()
    enqueue_due_workspaces(db)
    process_queued_jobs(db)
    print("Multi-workspace podcast worker finished.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"FATAL: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
