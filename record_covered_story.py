
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
STORY_FILE = ROOT / "output" / "selected_story.json"
UPLOAD_FILE = ROOT / "output" / "episode" / "spreaker_upload.json"
HISTORY_FILE = ROOT / "covered_stories.json"


def read_json(path):
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def clean_set(values):
    if not isinstance(values, list):
        return set()

    return {
        str(value).strip()
        for value in values
        if value is not None and str(value).strip()
    }


def main():
    if not STORY_FILE.exists():
        raise FileNotFoundError(
            "Selected story is missing. Cannot record history."
        )

    if not UPLOAD_FILE.exists():
        raise FileNotFoundError(
            "Spreaker upload result is missing. "
            "The story will not be marked as covered."
        )

    story = read_json(STORY_FILE)
    upload = read_json(UPLOAD_FILE)

    upload_status = upload.get("status")
    upload_details = upload.get("details", {})

    # Spreaker reports "published" after the uploaded draft is made public.
    # A published episode is also confirmed audio upload and must be recorded
    # in history; otherwise the legacy workflow can publish the same story
    # again on its next manual run.
    if upload_status not in {"draft_audio_uploaded", "published"}:
        raise RuntimeError(
            "Spreaker has not confirmed a completed audio upload. "
            f"Current upload status: {upload_status!r}. "
            "The story will not be added to history."
        )

    if upload_details.get("audio_uploaded") is not True:
        raise RuntimeError(
            "The Spreaker upload result does not confirm audio_uploaded. "
            "The story will not be added to history."
        )

    story_id = str(story.get("story_id", "")).strip()
    title = str(story.get("title", "")).strip()
    url = str(story.get("url", "")).strip()

    if not story_id or not title:
        raise ValueError(
            "Selected story is missing its story ID or title."
        )

    HISTORY_FILE.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    if HISTORY_FILE.exists():
        history = read_json(HISTORY_FILE)
    else:
        history = {}

    # Accept a simple list from older history formats.
    if isinstance(history, list):
        stories = history
        history = {"stories": stories}
    elif not isinstance(history, dict):
        raise ValueError(
            "The existing covered_stories.json has an unsupported format."
        )

    if not isinstance(history.get("stories"), list):
        history["stories"] = history.get(
            "covered_stories",
            [],
        )

    if not isinstance(history["stories"], list):
        history["stories"] = []

    # Preserve history from older formats.
    story_ids = clean_set(history.get("story_ids", []))
    urls = clean_set(history.get("urls", []))
    titles = clean_set(history.get("titles", []))

    previous_entries = history["stories"]

    for entry in previous_entries:
        if isinstance(entry, str):
            story_ids.add(entry)
        elif isinstance(entry, dict):
            old_id = entry.get("story_id") or entry.get("id")
            old_url = entry.get("url")
            old_title = entry.get("title")

            if old_id:
                story_ids.add(str(old_id))
            if old_url:
                urls.add(str(old_url).strip())
            if old_title:
                titles.add(" ".join(str(old_title).casefold().split()))

    existing_ids = {
        str(entry.get("story_id", entry.get("id", "")))
        for entry in previous_entries
        if isinstance(entry, dict)
    }

    if story_id not in existing_ids:
        previous_entries.append(
            {
                "story_id": story_id,
                "title": title,
                "url": url,
                "source": story.get("source", ""),
                "published_at": story.get("published_at", ""),
                "spreaker_show_id": str(upload.get("show_id", "")),
                "spreaker_episode_id": str(upload.get("episode_id", "")),
                "covered_at": datetime.now(timezone.utc).isoformat(),
            }
        )

    story_ids.add(story_id)

    if url:
        urls.add(url)

    if title:
        titles.add(" ".join(title.casefold().split()))

    history["schema_version"] = 1
    history["updated_at"] = datetime.now(timezone.utc).isoformat()
    history["story_ids"] = sorted(story_ids)
    history["urls"] = sorted(urls)
    history["titles"] = sorted(titles)
    history["stories"] = previous_entries

    # Do not write the access token or other credentials to this file.
    HISTORY_FILE.write_text(
        json.dumps(
            history,
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print("STORY HISTORY UPDATED", flush=True)
    print(f"Story: {title}", flush=True)
    print(f"Recorded story ID: {story_id}", flush=True)
    print(f"Spreaker episode ID: {upload.get('episode_id', '')}", flush=True)
    print(f"Total recorded story IDs: {len(story_ids)}", flush=True)
    print(f"History file: {HISTORY_FILE}", flush=True)


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
