
import json
import os
from pathlib import Path

import requests

API = "https://api.spreaker.com/v2"
TOKEN = os.environ.get("SPREAKER_ACCESS_TOKEN", "").strip()
UPLOAD_INFO = Path("output/episode/spreaker_upload.json")
THUMBNAIL = Path("output/episode/thumbnail.png")

if not TOKEN:
    raise RuntimeError("Missing SPREAKER_ACCESS_TOKEN secret.")

if not THUMBNAIL.exists():
    raise FileNotFoundError(f"Thumbnail not found: {THUMBNAIL}")

if not UPLOAD_INFO.exists():
    raise FileNotFoundError(f"Upload record not found: {UPLOAD_INFO}")

data = json.loads(UPLOAD_INFO.read_text(encoding="utf-8"))

def find_episode_id(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "episode_id" and item is not None:
                return str(item)
        for item in value.values():
            found = find_episode_id(item)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = find_episode_id(item)
            if found:
                return found
    return None

episode_id = find_episode_id(data)

if not episode_id:
    raise RuntimeError(
        "Could not find episode_id in spreaker_upload.json. "
        "Check the upload result before continuing."
    )

url = f"{API}/episodes/{episode_id}"
headers = {"Authorization": f"Bearer {TOKEN}"}

with THUMBNAIL.open("rb") as image_file:
    response = requests.post(
        url,
        headers=headers,
        files={"image_file": ("thumbnail.png", image_file, "image/png")},
        timeout=120,
    )

if not response.ok:
    raise RuntimeError(
        f"Spreaker thumbnail upload failed: "
        f"HTTP {response.status_code}: {response.text[:1000]}"
    )

print(f"Thumbnail uploaded to Spreaker episode {episode_id}.")
print("The script does not publish the episode.")
