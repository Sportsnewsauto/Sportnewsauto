
import json
import os
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path("output/episode")
ROOT.mkdir(parents=True, exist_ok=True)

STORY_FILE = Path("output/selected_story.json")
METADATA_FILE = ROOT / "youtube_metadata.json"
OUTPUT_FILE = ROOT / "thumbnail.png"

def read_json(path):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}

story = read_json(STORY_FILE)
metadata = read_json(METADATA_FILE)

def find_value(data, keys):
    if isinstance(data, dict):
        for key in keys:
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for value in data.values():
            result = find_value(value, keys)
            if result:
                return result
    elif isinstance(data, list):
        for item in data:
            result = find_value(item, keys)
            if result:
                return result
    return ""

headline = (
    find_value(metadata, ["title", "episode_title", "headline"])
    or find_value(story, ["title", "headline", "name"])
    or "TODAY'S TOP NEWS"
)

# Prefer a short headline for a readable thumbnail.
headline = headline.replace("\n", " ").strip()
if len(headline) > 100:
    headline = headline[:97].rsplit(" ", 1)[0] + "..."

W, H = 1280, 720
image = Image.new("RGB", (W, H))
pixels = image.load()

# Draw a dark navy-to-blue background without external images.
for y in range(H):
    for x in range(W):
        glow = max(0, 1 - (((x - 1050) / 850) ** 2 +
                           ((y - 100) / 650) ** 2) ** 0.5)
        pixels[x, y] = (
            int(8 + 10 * glow),
            int(17 + 25 * glow),
            int(39 + 45 * glow),
        )

draw = ImageDraw.Draw(image)

# Decorative red breaking-news strip.
draw.rectangle((0, 0, W, 18), fill=(225, 35, 48))
draw.rectangle((70, 82, 86, 590), fill=(235, 42, 54))

# Add a subtle geometric news graphic.
draw.ellipse((880, 115, 1390, 625), outline=(37, 72, 112), width=5)
draw.ellipse((950, 185, 1320, 555), outline=(37, 72, 112), width=3)

font_bold_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
font_regular_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

def get_font(size, bold=True):
    path = font_bold_path if bold else font_regular_path
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()

draw.text((115, 88), "OX NEWS DAILY", font=get_font(34), fill=(255, 255, 255))
draw.rectangle((115, 145, 410, 151), fill=(235, 42, 54))

# Fit and wrap the headline to the available space.
max_width = 1030
max_height = 350
font = get_font(76)

while font.size > 38:
    words = headline.split()
    lines = []
    line = ""

    for word in words:
        candidate = f"{line} {word}".strip()
        if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width:
            line = candidate
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)

    line_height = font.size + 15
    if (max(lines, key=lambda s: draw.textbbox((0, 0), s, font=font)[2])
            and len(lines) * line_height <= max_height
            and all(draw.textbbox((0, 0), s, font=font)[2] <= max_width
                    for s in lines)):
        break
    font = get_font(font.size - 4)

y = 205
for line in lines:
    draw.text((115, y), line, font=font, fill=(255, 255, 255),
              stroke_width=1, stroke_fill=(8, 17, 39))
    y += font.size + 15

# Bottom banner.
draw.rectangle((0, 625, W, H), fill=(218, 34, 47))
draw.text((75, 650), "U.S. NEWS  |  LATEST DEVELOPMENTS",
          font=get_font(27), fill=(255, 255, 255))

image.save(OUTPUT_FILE, format="PNG", optimize=True)
print(f"Thumbnail created: {OUTPUT_FILE}")
print(f"Headline: {headline}")
