
import json
import os
from datetime import datetime, timezone
import sys
import wave
from pathlib import Path

import requests


ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "output" / "episode"

AUDIO_FILE = OUTPUT_DIR / "podcast.wav"
METADATA_FILE = OUTPUT_DIR / "youtube_metadata.json"
RESULT_FILE = OUTPUT_DIR / "spreaker_upload.json"

API_BASE = "https://api.spreaker.com/v2"

# Automatic Spreaker advertising markers.
# Each marker allows a maximum of 4 advertisements.
# Timecodes are in milliseconds.
AD_CUEPOINTS = [
    {"timecode": 30000, "ads_max_count": 4},   # 30 seconds
    {"timecode": 60000, "ads_max_count": 4},   # 1 minute
    {"timecode": 120000, "ads_max_count": 4},  # 2 minutes
    {"timecode": 180000, "ads_max_count": 4},  # 3 minutes
]


def find_episode_id(data):
    """Find episode_id in Spreaker's JSON response."""
    if isinstance(data, dict):
        if data.get("episode_id") is not None:
            return data["episode_id"]

        for value in data.values():
            found = find_episode_id(value)
            if found is not None:
                return found

    elif isinstance(data, list):
        for value in data:
            found = find_episode_id(value)
            if found is not None:
                return found

    return None


def save_result(episode_id, show_id, title, status, details=None):
    """Save episode upload information."""
    result = {
        "show_id": show_id,
        "episode_id": str(episode_id),
        "title": title,
        "status": status,
        "details": details or {},
    }

    RESULT_FILE.parent.mkdir(parents=True, exist_ok=True)

    RESULT_FILE.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def get_audio_duration_ms():
    """Read the actual duration of the generated WAV file."""

    with wave.open(str(AUDIO_FILE), "rb") as audio:
        frame_rate = audio.getframerate()
        frame_count = audio.getnframes()

        if frame_rate <= 0:
            raise RuntimeError("Invalid WAV audio sample rate.")

        duration_ms = round(
            frame_count * 1000 / frame_rate
        )

    return int(duration_ms)


def add_ad_cuepoints(episode_id, headers, duration_ms):
    """
    Add advertisements at 30 seconds, 1 minute, 2 minutes, and 3 minutes.

    Each position allows a maximum of four advertisements.
    Markers beyond the audio duration are skipped.
    """

    valid_cuepoints = [
        cuepoint
        for cuepoint in AD_CUEPOINTS
        if cuepoint["timecode"] < duration_ms
    ]

    skipped_cuepoints = [
        cuepoint
        for cuepoint in AD_CUEPOINTS
        if cuepoint["timecode"] >= duration_ms
    ]

    print("", flush=True)
    print("=" * 55, flush=True)
    print("ADDING SPREAKER ADVERTISING MARKERS", flush=True)
    print(
        f"Episode duration: {duration_ms / 60000:.2f} minutes",
        flush=True,
    )

    for cuepoint in valid_cuepoints:
        minutes = cuepoint["timecode"] // 60000

        print(
            f"Ad marker at minute {minutes}: "
            f"maximum {cuepoint['ads_max_count']} ads",
            flush=True,
        )

    for cuepoint in skipped_cuepoints:
        minutes = cuepoint["timecode"] // 60000

        print(
            f"Skipping minute {minutes}: "
            "episode is not long enough.",
            flush=True,
        )

    if not valid_cuepoints:
        print(
            "WARNING: No advertising markers could be added.",
            flush=True,
        )
        print("=" * 55, flush=True)

        return {
            "success": False,
            "cuepoints": [],
            "skipped": skipped_cuepoints,
            "reason": "Episode too short for the configured markers.",
        }

    print("Sending cuepoints to Spreaker...", flush=True)

    response = requests.post(
        f"{API_BASE}/episodes/{episode_id}/cuepoints",
        headers=headers,
        data={
            "cuepoints": json.dumps(valid_cuepoints)
        },
        timeout=(30, 120),
    )

    if not response.ok:
        print(
            "ERROR: Spreaker rejected the advertising markers.",
            flush=True,
        )

        print(
            f"HTTP {response.status_code}: "
            f"{response.text[:2000]}",
            flush=True,
        )

        return {
            "success": False,
            "http_status": response.status_code,
            "error": response.text[:2000],
            "attempted_cuepoints": valid_cuepoints,
            "skipped": skipped_cuepoints,
        }

    try:
        response_data = response.json()
    except ValueError:
        response_data = {
            "raw_response": response.text[:1500]
        }

    print(
        "Advertising markers successfully submitted to Spreaker.",
        flush=True,
    )
    print("=" * 55, flush=True)

    return {
        "success": True,
        "cuepoints": valid_cuepoints,
        "skipped": skipped_cuepoints,
        "response": response_data,
    }


def main():
    token = os.getenv("SPREAKER_ACCESS_TOKEN")
    show_id = os.getenv("SPREAKER_SHOW_ID")

    if not token:
        raise RuntimeError(
            "SPREAKER_ACCESS_TOKEN is missing from GitHub Secrets."
        )

    if not show_id:
        raise RuntimeError(
            "SPREAKER_SHOW_ID is missing from GitHub Secrets."
        )

    if not AUDIO_FILE.exists():
        raise FileNotFoundError(
            f"Audio file not found: {AUDIO_FILE}"
        )

    if AUDIO_FILE.stat().st_size == 0:
        raise RuntimeError("The podcast WAV file is empty.")

    if not METADATA_FILE.exists():
        raise FileNotFoundError(
            f"Metadata file not found: {METADATA_FILE}"
        )

    with METADATA_FILE.open("r", encoding="utf-8") as file:
        metadata = json.load(file)

    title = str(metadata.get("title", "")).strip()
    description = str(metadata.get("description", "")).strip()
    tags = metadata.get("tags", [])

    if not title:
        raise ValueError("Episode title is missing.")

    if not description:
        raise ValueError("Episode description is missing.")

    if not description.startswith("contains AI\n\n"):
        raise ValueError(
            "The episode description must start with exactly "
            "'contains AI' followed by one blank line."
        )

    if isinstance(tags, list):
        tags_text = ",".join(
            str(tag).strip()
            for tag in tags
            if str(tag).strip()
        )
    else:
        tags_text = str(tags).strip()

    # Read actual WAV duration before uploading.
    duration_ms = get_audio_duration_ms()

    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": "OXNewsDaily-AutomatedPodcast/1.0",
    }

    print("=" * 55, flush=True)
    print("SPREAKER AUTOMATIC PUBLISH UPLOAD", flush=True)
    print(f"Show ID: {show_id}", flush=True)
    print(f"Episode title: {title}", flush=True)
    print(
        f"Audio size: "
        f"{AUDIO_FILE.stat().st_size / (1024 * 1024):.2f} MB",
        flush=True,
    )
    print(
        f"Audio duration: {duration_ms / 60000:.2f} minutes",
        flush=True,
    )
    print("Publishing mode: AUTOMATIC, publish immediately after upload", flush=True)
    print("=" * 55, flush=True)

    # STEP 1: Create a Spreaker draft for upload and metadata.
    draft_response = requests.post(
        f"{API_BASE}/episodes/drafts",
        headers=headers,
        data={
            "title": title,
            "show_id": show_id,
            "description": description,
            "tags": tags_text,
            "ai_generated": "1",
        },
        timeout=(30, 120),
    )

    if not draft_response.ok:
        raise RuntimeError(
            "Spreaker draft creation failed. "
            f"HTTP {draft_response.status_code}: "
            f"{draft_response.text[:2000]}"
        )

    try:
        draft_data = draft_response.json()
    except ValueError as exc:
        raise RuntimeError(
            "Spreaker returned an invalid JSON response "
            "when creating the draft."
        ) from exc

    episode_id = find_episode_id(draft_data)

    if episode_id is None:
        raise RuntimeError(
            "Spreaker created a response but no episode ID "
            "could be found. Response: "
            + json.dumps(draft_data)[:2000]
        )

    # Save episode ID immediately in case a later step fails.
    save_result(
        episode_id=episode_id,
        show_id=show_id,
        title=title,
        status="upload_record_created",
        details={
            "audio_uploaded": False
        },
    )

    print(
        f"Upload record created. Episode ID: {episode_id}",
        flush=True,
    )

    # STEP 2: Upload audio to the unpublished draft.
    print("Uploading podcast.wav to the episode...", flush=True)

    with AUDIO_FILE.open("rb") as audio:
        upload_response = requests.post(
            f"{API_BASE}/episodes/{episode_id}",
            headers=headers,
            files={
                "media_file": (
                    AUDIO_FILE.name,
                    audio,
                    "audio/wav",
                )
            },
            timeout=(30, 900),
        )

    if not upload_response.ok:
        save_result(
            episode_id=episode_id,
            show_id=show_id,
            title=title,
            status="audio_upload_failed",
            details={
                "audio_uploaded": False,
                "http_status": upload_response.status_code,
                "error": upload_response.text[:1500],
            },
        )

        raise RuntimeError(
            "The draft exists, but its audio upload failed. "
            f"HTTP {upload_response.status_code}: "
            f"{upload_response.text[:2000]}"
        )

    try:
        upload_data = upload_response.json()
    except ValueError:
        upload_data = {}

    print(
        "Podcast audio successfully uploaded.",
        flush=True,
    )

    # STEP 3: Add automatic advertising markers.
    cuepoint_result = add_ad_cuepoints(
        episode_id=episode_id,
        headers=headers,
        duration_ms=duration_ms,
    )

    if not cuepoint_result.get("success"):
        if "http_status" in cuepoint_result:
            save_result(
                episode_id=episode_id,
                show_id=show_id,
                title=title,
                status="audio_uploaded_cuepoints_failed",
                details={
                    "audio_uploaded": True,
                    "upload_response": upload_data,
                    "cuepoint_result": cuepoint_result,
                },
            )

            raise RuntimeError(
                "Audio uploaded, but Spreaker rejected the "
                "advertising markers. The draft is saved. "
                "Check the API error before retrying the workflow."
            )

    # STEP 4: Publish the episode immediately (Spreaker expects UTC).
    published_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"Publishing episode publicly at {published_at} UTC...", flush=True)

    publish_response = requests.post(
        f"{API_BASE}/episodes/{episode_id}",
        headers=headers,
        data={"published_at": published_at},
        timeout=(30, 120),
    )

    if not publish_response.ok:
        save_result(
            episode_id=episode_id,
            show_id=show_id,
            title=title,
            status="audio_uploaded_publish_failed",
            details={
                "audio_uploaded": True,
                "published_at_utc": published_at,
                "http_status": publish_response.status_code,
                "error": publish_response.text[:1500],
                "advertising_markers": cuepoint_result,
            },
        )
        raise RuntimeError(
            "Audio uploaded, but Spreaker could not publish the episode. "
            f"HTTP {publish_response.status_code}: {publish_response.text[:2000]}"
        )

    try:
        publish_data = publish_response.json()
    except ValueError:
        publish_data = {"raw_response": publish_response.text[:1500]}

    print("Spreaker accepted the publish request.", flush=True)

    # STEP 5: Save final upload, publishing, and advertising details.
    save_result(
        episode_id=episode_id,
        show_id=show_id,
        title=title,
        status="published",
        details={
            "audio_uploaded": True,
            "audio_duration_minutes": round(
                duration_ms / 60000, 2
            ),
            "upload_response": upload_data,
            "publish_response": publish_data,
            "published_at_utc": published_at,
            "advertising_markers": cuepoint_result,
        },
    )

    print("", flush=True)
    print("=" * 55, flush=True)
    print("SPREAKER AUTOMATIC PUBLISH COMPLETE", flush=True)
    print(f"Show: {show_id}", flush=True)
    print(f"Episode ID: {episode_id}", flush=True)
    print(f"Title: {title}", flush=True)
    print("Episode published publicly on Spreaker.", flush=True)

    if cuepoint_result.get("success"):
        print(
            "30-second marker: maximum 4 ads",
            flush=True,
        )
        print(
            "1-minute marker: maximum 4 ads",
            flush=True,
        )
        print(
            "2-minute marker: maximum 4 ads",
            flush=True,
        )
        print(
            "3-minute marker: maximum 4 ads",
            flush=True,
        )
        print(
            "Maximum possible ads across all four markers: 16",
            flush=True,
        )
    else:
        print(
            "WARNING: Episode uploaded, but its duration "
            "was too short for the configured markers.",
            flush=True,
        )

    print(f"Upload result: {RESULT_FILE}", flush=True)
    print("=" * 55, flush=True)


if __name__ == "__main__":
    try:
        main()

    except Exception as exc:
        print(
            f"ERROR: {type(exc).__name__}: {exc}",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)
