
import email.utils
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import html
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "output"
CONFIG_FILE = ROOT / "config.json"
STORY_FILE = OUTPUT_DIR / "selected_story.json"

# Persistent history is kept in the repository root.
HISTORY_FILE = ROOT / "covered_stories.json"


def local_tag(tag):
    """Remove XML namespaces from RSS and Atom tag names."""
    return tag.rsplit("}", 1)[-1].split(":")[-1].lower()


def clean_text(value):
    if not value:
        return ""

    value = html.unescape(value)
    value = re.sub(
        r"(?is)<(script|style).*?>.*?</\1>",
        " ",
        value,
    )
    value = re.sub(r"(?s)<[^>]+>", " ", value)
    value = re.sub(r"\s+", " ", value)

    return value.strip()


def normalize_url(url):
    """Normalize URLs to help identify repeated articles."""
    if not url:
        return ""

    try:
        parts = urlsplit(url.strip())

        return urlunsplit(
            (
                parts.scheme.lower(),
                parts.netloc.lower(),
                parts.path.rstrip("/"),
                parts.query,
                "",
            )
        )
    except Exception:
        return url.strip().rstrip("/")


def normalize_title(title):
    return " ".join((title or "").casefold().split())


def parse_date(value):
    """Parse common RSS and Atom publication dates."""
    if not value:
        return None

    value = value.strip()

    try:
        parsed = datetime.fromisoformat(
            value.replace("Z", "+00:00")
        )

        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)

        return parsed.astimezone(timezone.utc)

    except ValueError:
        pass

    try:
        parsed = email.utils.parsedate_to_datetime(value)

        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)

        return parsed.astimezone(timezone.utc)

    except (TypeError, ValueError, OverflowError):
        return None


def direct_field(element, names):
    """Get a direct RSS or Atom field."""
    names = {name.lower() for name in names}

    for child in list(element):
        if local_tag(child.tag) not in names:
            continue

        href = child.attrib.get("href")

        if href:
            return href.strip()

        if child.text:
            return child.text.strip()

    return ""


def make_story_id(url, guid, title):
    """
    Create a story ID independent of the feed name so the same
    article found in two different feeds gets the same ID.
    """
    identity = (
        normalize_url(url)
        or (guid or "").strip()
        or normalize_title(title)
    )

    return hashlib.sha256(
        identity.encode("utf-8")
    ).hexdigest()


def item_to_story(item, feed_name):
    title = clean_text(
        direct_field(item, ["title"])
    )

    url = normalize_url(
        direct_field(item, ["link"])
    )

    guid = direct_field(item, ["guid", "id"])

    published_value = direct_field(
        item,
        [
            "pubdate",
            "published",
            "updated",
            "date",
            "issued",
        ],
    )

    published = parse_date(published_value)

    summary = clean_text(
        direct_field(
            item,
            [
                "description",
                "summary",
                "encoded",
                "content",
            ],
        )
    )

    if not title or not published:
        return None

    story = {
        "story_id": make_story_id(url, guid, title),
        "guid": guid,
        "title": title,
        "source": feed_name,
        "published_at": published.isoformat(),
        "url": url,
        "summary": summary,
    }

    return story, published


def load_history():
    """Load known stories from persistent or older history files."""
    history = {
        "story_ids": set(),
        "urls": set(),
        "titles": set(),
    }

    possible_files = [
        HISTORY_FILE,
        OUTPUT_DIR / "covered_stories.json",
    ]

    for path in possible_files:
        if not path.exists():
            continue

        try:
            data = json.loads(
                path.read_text(encoding="utf-8")
            )
        except (OSError, json.JSONDecodeError) as exc:
            print(
                f"Warning: Could not read history file {path}: {exc}",
                flush=True,
            )
            continue

        if isinstance(data, list):
            entries = data

        elif isinstance(data, dict):
            entries = data.get(
                "stories",
                data.get("covered_stories", []),
            )

            for value in data.get(
                "story_ids",
                data.get("covered_story_ids", []),
            ):
                if value:
                    history["story_ids"].add(str(value))

            for value in data.get(
                "urls",
                data.get("covered_urls", []),
            ):
                if value:
                    history["urls"].add(normalize_url(str(value)))

            for value in data.get(
                "titles",
                data.get("covered_titles", []),
            ):
                if value:
                    history["titles"].add(
                        normalize_title(str(value))
                    )

        else:
            continue

        for entry in entries:
            if isinstance(entry, str):
                history["story_ids"].add(entry)
                continue

            if not isinstance(entry, dict):
                continue

            story_id = entry.get("story_id") or entry.get("id")
            url = entry.get("url", "")
            title = entry.get("title", "")

            if story_id:
                history["story_ids"].add(str(story_id))

            if url:
                history["urls"].add(normalize_url(str(url)))

            if title:
                history["titles"].add(normalize_title(str(title)))

    return history


def already_covered(story, history):
    if story["story_id"] in history["story_ids"]:
        return True

    url = normalize_url(story.get("url", ""))

    if url and url in history["urls"]:
        return True

    title = normalize_title(story.get("title", ""))

    if title and title in history["titles"]:
        return True

    return False


def fetch_feed(feed):
    name = feed["name"]
    url = feed["url"]

    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "AutomatedPodcast/1.0",
            "Accept": (
                "application/rss+xml, application/atom+xml, "
                "application/xml, text/xml"
            ),
        },
    )

    with urllib.request.urlopen(
        request,
        timeout=30,
    ) as response:
        content = response.read()

    root = ET.fromstring(content)
    stories = []

    for item in root.iter():
        if local_tag(item.tag) not in {"item", "entry"}:
            continue

        result = item_to_story(item, name)

        if result is not None:
            stories.append(result)

    print(
        f"Feed {name}: found {len(stories)} dated stories.",
        flush=True,
    )

    return stories


def main():
    if not CONFIG_FILE.exists():
        raise FileNotFoundError(
            f"Configuration file missing: {CONFIG_FILE}"
        )

    config = json.loads(
        CONFIG_FILE.read_text(encoding="utf-8")
    )

    feeds = config.get("rss_feeds", [])

    if not feeds:
        raise RuntimeError(
            "No RSS feeds are configured in config.json."
        )

    max_age_hours = int(
        config.get("max_story_age_hours", 24)
    )

    skip_previous = config.get(
        "skip_previously_covered_stories",
        True,
    )

    history = load_history()

    print(
        f"Recorded story IDs: {len(history['story_ids'])}",
        flush=True,
    )
    print(
        f"Skip previously covered stories: {skip_previous}",
        flush=True,
    )

    now = datetime.now(timezone.utc)
    oldest_allowed = now - timedelta(hours=max_age_hours)

    candidates = []
    feed_errors = []

    # Fetch feeds concurrently to avoid waiting on every publisher in sequence.
    max_workers = min(8, max(1, len(feeds)))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_feed = {
            executor.submit(fetch_feed, feed): feed
            for feed in feeds
        }

        for future in as_completed(future_to_feed):
            feed = future_to_feed[future]
            try:
                feed_stories = future.result()
            except Exception as exc:
                message = f"{feed.get('name', 'RSS feed')}: {exc}"
                feed_errors.append(message)
                print(f"Warning: Failed to read {message}", flush=True)
                continue

            for story, published in feed_stories:
                if published < oldest_allowed:
                    continue
                if published > now + timedelta(hours=1):
                    continue
                if skip_previous and already_covered(story, history):
                    continue
                candidates.append((story, published))

    if not candidates:
        details = (
            "\n".join(feed_errors)
            if feed_errors
            else "No eligible, uncovered stories were found."
        )

        raise RuntimeError(
            "No eligible new news story is available. "
            "Stopping instead of intentionally selecting a duplicate.\n"
            + details
        )

    # Pick the newest eligible article from all configured feeds.
    candidates.sort(
        key=lambda item: item[1],
        reverse=True,
    )

    selected_story = candidates[0][0]

    OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    STORY_FILE.write_text(
        json.dumps(
            selected_story,
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print("", flush=True)
    print("NEWS STORY SELECTED", flush=True)
    print(f"Headline: {selected_story['title']}", flush=True)
    print(f"Publisher: {selected_story['source']}", flush=True)
    print(f"Published: {selected_story['published_at']}", flush=True)
    print(f"Article URL: {selected_story['url']}", flush=True)
    print(f"Story ID: {selected_story['story_id']}", flush=True)
    print(f"Saved to: {STORY_FILE}", flush=True)


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
