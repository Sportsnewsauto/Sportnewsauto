
import json
import os
import re
import sys
import time
from pathlib import Path

import requests

from google import genai
from google.genai import types


ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "output" / "episode"
STORY_FILE = ROOT / "output" / "selected_story.json"
NARRATION_FILE = OUTPUT_DIR / "narration.txt"

MODEL = os.getenv(
    "GEMINI_TEXT_MODEL",
    "gemini-3.5-flash-lite",
)

AI_DISCLOSURE = "contains AI"
FORBIDDEN_PUBLICATION_NAMES = ("CNN", "BBC", "Reuters", "Fox News")

MAX_ATTEMPTS = 6


def is_retryable_error(exc):
    """Identify temporary API, server, timeout, and connection errors."""
    message = f"{type(exc).__name__}: {exc}".upper()

    retryable_terms = [
        "429",
        "500",
        "502",
        "503",
        "504",
        "408",
        "UNAVAILABLE",
        "RESOURCE_EXHAUSTED",
        "INTERNAL SERVER ERROR",
        "BAD GATEWAY",
        "GATEWAY TIMEOUT",
        "DEADLINE_EXCEEDED",
        "TIMEOUT",
        "TIMED OUT",
        "CONNECTION ERROR",
        "CONNECTION RESET",
        "CONNECTION ABORTED",
        "CONNECTION REFUSED",
        "REMOTE PROTOCOL ERROR",
        "SERVER DISCONNECTED",
        "NETWORK ERROR",
        "TEMPORARILY UNAVAILABLE",
        "SERVICE UNAVAILABLE",
    ]

    return any(term in message for term in retryable_terms)


def generate_metadata(client, prompt):
    """Generate metadata with Groq first and Gemini as a fallback."""
    groq_key = os.getenv("GROQ_API_KEY")
    if groq_key:
        model = os.getenv("GROQ_TEXT_MODEL", "openai/gpt-oss-120b")
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                print(
                    f"Groq metadata attempt {attempt} of {MAX_ATTEMPTS} using {model}...",
                    flush=True,
                )
                response = requests.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {groq_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": model,
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": 0.4,
                        "max_completion_tokens": 2500,
                        "response_format": {"type": "json_object"},
                        "reasoning_effort": "low",
                    },
                    timeout=180,
                )
                response.raise_for_status()
                raw = response.json()["choices"][0]["message"]["content"]
                metadata = json.loads(raw)
                if not isinstance(metadata, dict):
                    raise ValueError("Groq returned JSON that is not an object.")
                for field in ("title", "description", "tags"):
                    if field not in metadata:
                        raise ValueError(f"Groq metadata is missing field: {field}")
                print(f"Groq metadata generated successfully with {model}.", flush=True)
                return metadata
            except Exception as exc:
                retryable = is_retryable_error(exc)
                if isinstance(exc, (json.JSONDecodeError, ValueError)):
                    retryable = True
                if attempt >= MAX_ATTEMPTS or not retryable:
                    print(
                        f"Groq metadata failed: {type(exc).__name__}: {exc}",
                        file=sys.stderr,
                        flush=True,
                    )
                    break
                delay = min(60, attempt * 10)
                print(
                    f"Groq metadata attempt failed: {exc}. Retrying in {delay}s...",
                    file=sys.stderr,
                    flush=True,
                )
                time.sleep(delay)

    if client is None:
        raise RuntimeError(
            "Groq metadata generation failed and GEMINI_API_KEY is not configured."
        )

    print("Falling back to Gemini for episode metadata.", flush=True)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            print(
                f"Gemini metadata attempt {attempt} of {MAX_ATTEMPTS}...",
                flush=True,
            )
            response = client.models.generate_content(
                model=os.getenv("GEMINI_TEXT_MODEL", "gemini-3.5-flash-lite"),
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.4,
                    max_output_tokens=2500,
                    response_mime_type="application/json",
                ),
            )
            if not response.text:
                raise ValueError("Gemini returned an empty metadata response.")
            metadata = json.loads(response.text)
            if not isinstance(metadata, dict):
                raise ValueError("Gemini returned JSON that is not an object.")
            required_fields = ["title", "description", "tags"]
            missing_fields = [field for field in required_fields if field not in metadata]
            if missing_fields:
                raise ValueError("Gemini metadata is missing fields: " + ", ".join(missing_fields))
            print("Gemini metadata response received successfully.", flush=True)
            return metadata
        except Exception as exc:
            retryable = is_retryable_error(exc)
            if isinstance(exc, (json.JSONDecodeError, ValueError)):
                retryable = True
            if attempt >= MAX_ATTEMPTS or not retryable:
                raise
            delay = min(60, attempt * 10)
            print(
                f"Gemini metadata attempt failed: {exc}. Retrying in {delay}s...",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(delay)

    raise RuntimeError("Metadata generation failed after all provider attempts.")

def main():
    api_key = os.getenv("GEMINI_API_KEY")
    groq_api_key = os.getenv("GROQ_API_KEY")

    if not api_key and not groq_api_key:
        raise RuntimeError(
            "Configure at least one GitHub secret: GROQ_API_KEY or GEMINI_API_KEY."
        )

    if not STORY_FILE.exists():
        raise FileNotFoundError(
            "Selected story not found. Run fetch_news.py first."
        )

    if not NARRATION_FILE.exists():
        raise FileNotFoundError(
            "Narration not found. Generate and validate the script first."
        )

    with STORY_FILE.open("r", encoding="utf-8") as file:
        story = json.load(file)

    narration = NARRATION_FILE.read_text(
        encoding="utf-8"
    ).strip()

    if not narration:
        raise ValueError("The narration file is empty.")

    # Use the beginning and ending of a long episode as context.
    if len(narration) > 18000:
        episode_context = (
            narration[:12000]
            + "\n\n[Middle of episode omitted]\n\n"
            + narration[-6000:]
        )
    else:
        episode_context = narration

    prompt = f"""
You create accurate, engaging YouTube metadata for news podcasts.

PODCAST IDENTITY
Podcast name: {os.getenv("PODCAST_NAME", "Sports News Podcast")}
Podcast description: {os.getenv("PODCAST_DESCRIPTION", "Independent sports news and analysis.")}
Category: {os.getenv("PODCAST_CATEGORY", "Sports")}
Language: {os.getenv("PODCAST_LANGUAGE", "en")}
Country focus: {os.getenv("PODCAST_COUNTRY", "KE")}

STORY HEADLINE
{story.get("title", "News podcast episode")}

NEWS PUBLISHER
{story.get("source", "Not specified")}

EPISODE NARRATION
{episode_context}

Create these three items.

TITLE:
Write one compelling, accurate, search-friendly YouTube title
under 100 characters. Do not use misleading clickbait. Do not mention
CNN, BBC, Reuters, Fox News, or any other major news publication.

DESCRIPTION:
The description must begin with this exact lowercase text on its own line:
{AI_DISCLOSURE}

After one blank line, write a useful description of this specific
episode. Explain the main story, important background, major issues,
and why the topic matters. Use readable paragraphs and relevant search
terms naturally. Do not invent facts, quotations, dates, or statistics.
Do not claim to have checked sources that were not supplied. Do not
mention CNN, BBC, Reuters, Fox News, or any other major news publication.
End with two to four relevant hashtags.

TAGS:
Provide 12 to 20 relevant YouTube tags as separate strings.
Include the story's subject, relevant names, related topics, and
news podcast search terms. Avoid unrelated or repetitive tags.

Return valid JSON only in this exact structure:
{{
  "title": "Your title",
  "description": "Your description",
  "tags": ["tag one", "tag two", "tag three"]
}}
"""

    OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    client = genai.Client(api_key=api_key) if api_key else None

    print(
        "Generating YouTube title, description, and tags...",
        flush=True,
    )

    metadata = generate_metadata(client, prompt)

    title = str(metadata.get("title", "")).strip()
    description = str(metadata.get("description", "")).strip()
    tags = metadata.get("tags", [])

    if not title:
        raise ValueError("No YouTube title was generated.")

    if len(title) > 100:
        title = title[:97].rstrip() + "..."

    if not description:
        raise ValueError("No YouTube description was generated.")

    # Remove any disclosure-like first line Gemini may have supplied,
    # including the previous longer disclosure, then enforce the exact
    # required lowercase disclosure and one blank line.
    description = re.sub(
        r"^\s*contains\s+ai[^\r\n]*(?:\r?\n|$)",
        "",
        description,
        count=1,
        flags=re.IGNORECASE,
    ).strip()

    description = AI_DISCLOSURE + "\n\n" + description

    # Preserve the publication-name restriction for both title and description.
    publication_pattern = re.compile(
        r"\b(?:" + "|".join(
            re.escape(name) for name in FORBIDDEN_PUBLICATION_NAMES
        ) + r")\b",
        flags=re.IGNORECASE,
    )
    for field_name, field_value in (
        ("title", title),
        ("description", description),
    ):
        match = publication_pattern.search(field_value)
        if match:
            raise ValueError(
                f"Generated {field_name} mentions a prohibited news "
                f"publication: {match.group(0)}"
            )

    if not isinstance(tags, list):
        raise ValueError("Generated tags are not in list format.")

    cleaned_tags = []
    seen = set()

    for tag in tags:
        if not isinstance(tag, str):
            continue

        tag = re.sub(r"\s+", " ", tag).strip()

        if not tag:
            continue

        key = tag.casefold()

        if key not in seen:
            seen.add(key)
            cleaned_tags.append(tag)

    if not cleaned_tags:
        raise ValueError("No usable tags were generated.")

    metadata = {
        "title": title,
        "description": description,
        "tags": cleaned_tags,
    }

    json_path = OUTPUT_DIR / "youtube_metadata.json"
    text_path = OUTPUT_DIR / "youtube_metadata.txt"

    json_path.write_text(
        json.dumps(
            metadata,
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    text_content = (
        "YOUTUBE TITLE\n"
        + title
        + "\n\nYOUTUBE DESCRIPTION\n"
        + description
        + "\n\nYOUTUBE TAGS\n"
        + ", ".join(cleaned_tags)
        + "\n"
    )

    text_path.write_text(
        text_content,
        encoding="utf-8",
    )

    print("", flush=True)
    print("YOUTUBE METADATA COMPLETE", flush=True)
    print(f"Title: {title}", flush=True)
    print(f"Tags generated: {len(cleaned_tags)}", flush=True)
    print(f"Text file: {text_path}", flush=True)
    print(f"JSON file: {json_path}", flush=True)


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
