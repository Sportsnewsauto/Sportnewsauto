#!/usr/bin/env python3
"""One-time, idempotent import of the previous sports automation into Admin.

This script runs only from the protected GitHub Actions workflow. It uses the
server-side Supabase secret, never reads or copies provider credentials, and
leaves automation_enabled=false until the Admin reconnects their own services.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests


def fail(message: str) -> None:
    print(f"IMPORT FAILED: {message}", file=sys.stderr)
    raise SystemExit(1)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    supabase_url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    secret_key = os.environ.get("SUPABASE_SECRET_KEY", "").strip()
    admin_email = os.environ.get("ADMIN_EMAIL", "").strip().lower()

    if not supabase_url or not secret_key or not admin_email:
        fail("Missing SUPABASE_URL, SUPABASE_SECRET_KEY, or Admin email input.")

    headers = {
        "apikey": secret_key,
        "Content-Type": "application/json",
    }
    # Compatibility with older JWT-based Supabase service-role keys.
    if not secret_key.startswith("sb_secret_"):
        headers["Authorization"] = f"Bearer {secret_key}"

    session = requests.Session()
    session.headers.update(headers)
    base = f"{supabase_url}/rest/v1"

    def api(method: str, table: str, *, params: dict[str, str] | None = None,
            payload: Any = None, prefer: str | None = None) -> Any:
        request_headers = {}
        if prefer:
            request_headers["Prefer"] = prefer
        response = session.request(
            method,
            f"{base}/{table}",
            params=params,
            json=payload,
            headers=request_headers,
            timeout=30,
        )
        if not response.ok:
            detail = response.text[:1200]
            fail(f"Supabase {method} {table} returned HTTP {response.status_code}: {detail}")
        if response.status_code == 204 or not response.content:
            return None
        return response.json()

    # Resolve the owner from the existing Auth-triggered profile, not a
    # user-supplied UUID. Exact case-insensitive email match is required.
    profiles = api(
        "GET", "profiles",
        params={"select": "id,email", "email": f"ilike.{admin_email}", "limit": "5"},
    )
    matches = [p for p in (profiles or []) if str(p.get("email", "")).lower() == admin_email]
    if len(matches) != 1:
        fail("Could not identify exactly one Admin account from its email. Check the email input and profile.")
    owner_id = matches[0]["id"]

    workspaces = api(
        "GET", "workspaces",
        params={"select": "id,plan,daily_episode_limit", "owner_id": f"eq.{owner_id}", "limit": "2"},
    )
    if len(workspaces or []) != 1:
        fail("The Admin workspace was not found or is not unique.")

    source_path = Path("website/data/legacy-sports-automation.json")
    if not source_path.exists():
        fail(f"Legacy import data file is missing: {source_path}")
    with source_path.open("r", encoding="utf-8") as file:
        legacy = json.load(file)

    feeds = legacy.get("feeds", [])
    history = legacy.get("history", [])
    if len(feeds) != 49 or len(history) != 65:
        fail(f"Unexpected import bundle size (feeds={len(feeds)}, history={len(history)}); refusing to continue.")

    settings_rows = api(
        "GET", "workspace_settings",
        params={"select": "*", "owner_id": f"eq.{owner_id}", "limit": "1"},
    )
    existing_settings = settings_rows[0] if settings_rows else {}
    timestamp = now_iso()

    feed_rows = [{
        "owner_id": owner_id,
        "name": feed["name"],
        "feed_url": feed["feed_url"],
        "sport": feed.get("sport") or "General",
        "league": feed.get("league") or "",
        "enabled": True,
        "updated_at": timestamp,
    } for feed in feeds]

    api(
        "POST", "news_feeds",
        params={"on_conflict": "owner_id,feed_url"},
        payload=feed_rows,
        prefer="resolution=merge-duplicates,return=minimal",
    )

    scheduled_times = ["00:00", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00"]
    settings = {
        "owner_id": owner_id,
        "podcast_name": existing_settings.get("podcast_name") or "Sports News Podcast",
        "podcast_description": existing_settings.get("podcast_description") or "",
        "category": existing_settings.get("category") or "Sports",
        "language": existing_settings.get("language") or "en",
        "country": existing_settings.get("country") or "KE",
        "spreaker_show_id": existing_settings.get("spreaker_show_id") or "",
        "timezone": "Africa/Nairobi",
        "ai_provider": existing_settings.get("ai_provider") or "groq",
        "ai_model": existing_settings.get("ai_model") or "openai/gpt-oss-120b",
        "ai_writing_instructions": existing_settings.get("ai_writing_instructions") or "",
        "tts_provider": "kokoro",
        "tts_voice": "af_heart",
        "publishing_mode": "automatic",
        "scheduled_times": scheduled_times,
        "automation_enabled": False,
        "updated_at": timestamp,
    }
    api(
        "POST", "workspace_settings",
        params={"on_conflict": "owner_id"},
        payload=settings,
        prefer="resolution=merge-duplicates,return=minimal",
    )

    ad_slots = [
        {"position_seconds": 30, "ads_max_count": 4, "label": "Ad break at 30 seconds", "enabled": True},
        {"position_seconds": 60, "ads_max_count": 4, "label": "Ad break at 1 minute", "enabled": True},
        {"position_seconds": 120, "ads_max_count": 4, "label": "Ad break at 2 minutes", "enabled": True},
        {"position_seconds": 180, "ads_max_count": 4, "label": "Ad break at 3 minutes", "enabled": True},
    ]
    api(
        "POST", "ad_slots",
        params={"on_conflict": "owner_id,position_seconds"},
        payload=[{**slot, "owner_id": owner_id, "updated_at": timestamp} for slot in ad_slots],
        prefer="resolution=merge-duplicates,return=minimal",
    )

    existing_episodes = api(
        "GET", "episodes",
        params={
            "select": "spreaker_episode_id,source_data",
            "owner_id": f"eq.{owner_id}",
            "limit": "5000",
        },
    ) or []
    existing_story_ids: set[str] = set()
    existing_spreaker_ids: set[str] = set()
    for episode in existing_episodes:
        if episode.get("spreaker_episode_id"):
            existing_spreaker_ids.add(str(episode["spreaker_episode_id"]))
        source_data = episode.get("source_data")
        if isinstance(source_data, dict) and isinstance(source_data.get("story_id"), str):
            existing_story_ids.add(source_data["story_id"])

    new_history = []
    for story in history:
        story_id = story.get("story_id")
        episode_id = str(story.get("spreaker_episode_id") or "")
        if not story_id or not episode_id:
            continue
        if story_id in existing_story_ids or episode_id in existing_spreaker_ids:
            continue
        imported_at = story.get("covered_at") or timestamp
        new_history.append({
            "owner_id": owner_id,
            "title": story.get("title") or "Previous sports podcast episode",
            "description": "Imported from the previous single-account sports podcast automation.",
            "status": "published",
            "spreaker_episode_id": episode_id,
            "source_data": {
                "story_id": story_id,
                "url": story.get("url") or "",
                "title": story.get("title") or "",
                "source": story.get("source") or "",
                "published_at": story.get("published_at"),
                "spreaker_show_id": story.get("spreaker_show_id"),
                "legacy_import": True,
            },
            "generated_at": imported_at,
            "published_at": imported_at,
            "created_at": imported_at,
            "updated_at": timestamp,
        })

    if new_history:
        api("POST", "episodes", payload=new_history, prefer="return=minimal")

    # Upgrade only the matched Admin workspace, after its settings and history
    # have been copied. Migration 0005 must already allow the 'admin' plan.
    api(
        "PATCH", "workspaces",
        params={"owner_id": f"eq.{owner_id}"},
        payload={"plan": "admin", "daily_episode_limit": 8, "updated_at": timestamp},
        prefer="return=minimal",
    )

    print("IMPORT COMPLETE")
    print(f"Sports feeds configured: {len(feed_rows)}")
    print(f"Ad positions configured: {len(ad_slots)} (4 ads maximum at each position)")
    print(f"Previous episodes added: {len(new_history)}")
    print(f"Previous episodes already present: {len(history) - len(new_history)}")
    print("Schedule: 8 runs/day, every 3 hours, Africa/Nairobi")
    print("Publishing preference: automatic")
    print("Safety: Admin automation remains PAUSED until personal provider accounts are connected.")
    print("Provider credentials copied: 0")


if __name__ == "__main__":
    main()
