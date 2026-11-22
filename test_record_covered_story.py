import json
import tempfile
import unittest
from pathlib import Path

import record_covered_story


class RecordCoveredStoryTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        record_covered_story.ROOT = root
        record_covered_story.STORY_FILE = root / "output" / "selected_story.json"
        record_covered_story.UPLOAD_FILE = root / "output" / "episode" / "spreaker_upload.json"
        record_covered_story.HISTORY_FILE = root / "covered_stories.json"
        record_covered_story.STORY_FILE.parent.mkdir(parents=True)
        record_covered_story.UPLOAD_FILE.parent.mkdir(parents=True)
        record_covered_story.STORY_FILE.write_text(json.dumps({
            "story_id": "story-123",
            "title": "Sports result",
            "url": "https://example.com/story",
            "source": "Example",
        }), encoding="utf-8")

    def tearDown(self):
        self.temp_dir.cleanup()

    def write_upload(self, status, audio_uploaded=True):
        record_covered_story.UPLOAD_FILE.write_text(json.dumps({
            "status": status,
            "episode_id": "76517041",
            "show_id": "12345",
            "details": {"audio_uploaded": audio_uploaded},
        }), encoding="utf-8")

    def test_published_episode_is_recorded_in_history(self):
        self.write_upload("published")
        record_covered_story.main()
        history = json.loads(record_covered_story.HISTORY_FILE.read_text(encoding="utf-8"))
        self.assertIn("story-123", history["story_ids"])
        self.assertEqual(history["stories"][0]["spreaker_episode_id"], "76517041")

    def test_draft_audio_upload_is_still_recorded(self):
        self.write_upload("draft_audio_uploaded")
        record_covered_story.main()
        history = json.loads(record_covered_story.HISTORY_FILE.read_text(encoding="utf-8"))
        self.assertIn("story-123", history["story_ids"])

    def test_published_status_without_audio_confirmation_is_rejected(self):
        self.write_upload("published", audio_uploaded=False)
        with self.assertRaisesRegex(RuntimeError, "does not confirm audio_uploaded"):
            record_covered_story.main()


if __name__ == "__main__":
    unittest.main()
