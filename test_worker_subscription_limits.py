"""Regression tests for Podcasti's subscription and worker entitlements."""
from __future__ import annotations

import base64
import os
import unittest
from datetime import datetime, timezone

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SECRET_KEY", "test-only-supabase-key")
os.environ.setdefault(
    "CREDENTIAL_ENCRYPTION_KEY",
    base64.b64encode(b"0123456789abcdef0123456789abcdef").decode("ascii"),
)

import tenant_worker  # noqa: E402


class RecordingDatabase:
    def __init__(self, rows=None):
        self.rows = rows or []
        self.calls = []

    def select(self, table, **params):
        self.calls.append((table, params))
        return self.rows


class SubscriptionEntitlementTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 22, 9, 0, tzinfo=timezone.utc)

    def test_admin_plan_never_expires(self):
        workspace = {
            "plan": "admin",
            "subscription_status": "inactive",
            "subscription_expires_at": None,
        }
        self.assertEqual(tenant_worker.effective_workspace_plan(workspace, self.now), "admin")

    def test_active_monthly_subscription_is_paid_until_expiry(self):
        workspace = {
            "plan": "pro",
            "subscription_status": "active",
            "subscription_expires_at": "2026-12-22T09:00:00+00:00",
        }
        self.assertEqual(tenant_worker.effective_workspace_plan(workspace, self.now), "pro")

    def test_expired_subscription_falls_back_to_free(self):
        workspace = {
            "plan": "pro",
            "subscription_status": "active",
            "subscription_expires_at": "2026-11-21T09:00:00+00:00",
        }
        self.assertEqual(tenant_worker.effective_workspace_plan(workspace, self.now), "free")

    def test_pending_or_missing_expiry_is_not_paid(self):
        for status, expiry in (
            ("pending", "2026-12-22T09:00:00+00:00"),
            ("active", None),
            ("inactive", "2026-12-22T09:00:00+00:00"),
        ):
            workspace = {
                "plan": "pro",
                "subscription_status": status,
                "subscription_expires_at": expiry,
            }
            self.assertEqual(tenant_worker.effective_workspace_plan(workspace, self.now), "free")

    def test_free_workspace_only_uses_two_rss_feeds(self):
        feeds = [{"name": f"feed-{n}", "url": f"https://example.com/{n}.xml"} for n in range(4)]
        self.assertEqual(len(tenant_worker.workspace_feeds_for_plan(feeds, "free")), 2)
        self.assertEqual(len(tenant_worker.workspace_feeds_for_plan(feeds, "pro")), 4)
        self.assertEqual(len(tenant_worker.workspace_feeds_for_plan(feeds, "admin")), 4)

    def test_free_workspace_always_uses_the_single_bella_voice(self):
        self.assertEqual(
            tenant_worker.workspace_kokoro_voice({"tts_voice": "bm_george"}, "free"),
            "af_bella",
        )

    def test_paid_workspace_can_use_standard_voice_but_not_admin_reserved_voice(self):
        self.assertEqual(
            tenant_worker.workspace_kokoro_voice({"tts_voice": "bf_emma"}, "pro"),
            "bf_emma",
        )
        self.assertEqual(
            tenant_worker.workspace_kokoro_voice({"tts_voice": "af_heart"}, "pro"),
            "af_bella",
        )

    def test_admin_workspace_can_keep_reserved_voice(self):
        self.assertEqual(
            tenant_worker.workspace_kokoro_voice({"tts_voice": "af_heart"}, "admin"),
            "af_heart",
        )

    def test_rolling_episode_count_uses_last_30_days(self):
        db = RecordingDatabase(rows=[{"id": "episode-1"}, {"id": "episode-2"}])
        self.assertEqual(
            tenant_worker.rolling_episode_count(db, "owner-1", self.now),
            2,
        )
        table, params = db.calls[0]
        self.assertEqual(table, "episodes")
        self.assertEqual(params["owner_id"], "eq.owner-1")
        self.assertEqual(params["created_at"], "gte.2026-10-23T09:00:00+00:00")
        self.assertEqual(
            params["status"],
            "in.(draft,queued,processing,ready,published)",
        )


if __name__ == "__main__":
    unittest.main()
