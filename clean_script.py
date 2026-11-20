
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "output" / "episode"
SCRIPT_FILE = OUTPUT_DIR / "script.md"
NARRATION_FILE = OUTPUT_DIR / "narration.txt"
CONFIG_FILE = ROOT / "config.json"

MINIMUM_NARRATION_CHARACTERS = 13500


def main():
    if not SCRIPT_FILE.exists():
        raise FileNotFoundError(
            f"{SCRIPT_FILE} is missing. Generate the script first."
        )

    config = {}

    if CONFIG_FILE.exists():
        with CONFIG_FILE.open("r", encoding="utf-8") as file:
            config = json.load(file)

    minimum_required = max(
        MINIMUM_NARRATION_CHARACTERS,
        int(config.get("minimum_narration_characters", 13500)),
    )

    script_text = SCRIPT_FILE.read_text(encoding="utf-8")

    begin_count = script_text.count("BEGIN_NARRATION")
    end_count = script_text.count("END_NARRATION")

    if begin_count == 0:
        raise RuntimeError("No narration sections were found.")

    if begin_count != end_count:
        raise RuntimeError(
            f"Narration markers do not match: {begin_count} BEGIN "
            f"markers and {end_count} END markers."
        )

    pattern = re.compile(
        r"BEGIN_NARRATION\s*(.*?)\s*END_NARRATION",
        re.DOTALL,
    )

    sections = pattern.findall(script_text)

    if len(sections) != begin_count:
        raise RuntimeError(
            "Some narration blocks could not be extracted."
        )

    sections = [section.strip() for section in sections]

    for number, section in enumerate(sections, start=1):
        if not section:
            raise RuntimeError(
                f"Narration section {number} is empty."
            )

    narration_text = "\n\n".join(sections).strip()

    # Expand dotted U.S. initials so text-to-speech does not treat the
    # abbreviation periods as sentence-ending pauses.
    narration_text, us_expansions = re.subn(
        r"\bU\s*\.\s*S\s*\.",
        "United States",
        narration_text,
        flags=re.IGNORECASE,
    )
    if us_expansions:
        print(
            f"Expanded U.S. abbreviation {us_expansions} time(s) for narration.",
            flush=True,
        )

    actual_length = len(narration_text)

    print(f"Sections found: {len(sections)}", flush=True)
    print(f"Narration characters: {actual_length}", flush=True)
    print(f"Minimum required: {minimum_required}", flush=True)

    if actual_length < minimum_required:
        raise RuntimeError(
            f"Narration contains {actual_length} characters. "
            f"At least {minimum_required} are required."
        )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    NARRATION_FILE.write_text(narration_text, encoding="utf-8")

    print("SCRIPT VALIDATION COMPLETE", flush=True)
    print(f"Narration file: {NARRATION_FILE}", flush=True)


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
