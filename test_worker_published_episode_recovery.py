"""Regression tests for safe persistence after a confirmed Spreaker publish."""
from __future__ import annotations

import copy
import requests
import unittest

import tenant_worker


class FakeDatabase:
    def __init__(self, commit_then_timeout=False):
        self.episodes = []
        self.jobs = {}
        self.commit_then_timeout = commit_then_timeout
        self.insert_calls = 0
        self.patch_calls = []

    def select(self, table, **params):
        if table == "episodes":
            owner = params.get("owner_id", "").removeprefix("eq.")
            worker_job = params.get("source_data->>worker_job_id", "").removeprefix("eq.")
            return [
                {"id": row["id"], "spreaker_episode_id": row.get("spreaker_episode_id")}
                for row in self.episodes
                if row.get("owner_id") == owner
                and (row.get("source_data") or {}).get("worker_job_id") == worker_job
            ][:1]
        if table == "publishing_jobs":
            job_id = params.get("id", "").removeprefix("eq.")
            row = self.jobs.get(job_id)
            return [{"payload": copy.deepcopy(row.get("payload", {}))}] if row else []
        return []

    def insert(self, table, body, **kwargs):
        if table == "episodes":
            self.insert_calls += 1
            stored = copy.deepcopy(body)
            stored["id"] = "episode-row-1"
            self.episodes.append(stored)
            if self.commit_then_timeout:
                self.commit_then_timeout = False
                raise requests.exceptions.ReadTimeout("simulated response timeout after commit")
            return [stored]
        raise AssertionError(f"Unexpected insert into {table}")

    def patch(self, table, params, body):
        self.patch_calls.append((table, params, copy.deepcopy(body)))
        if table == "episodes":
            row_id = params.get("id", "").removeprefix("eq.")
            for row in self.episodes:
                if row["id"] == row_id:
                    row.update(copy.deepcopy(body))
                    return [row]
        elif table == "publishing_jobs":
            job_id = params.get("id", "").removeprefix("eq.")
            row = self.jobs.setdefault(job_id, {})
            row.update(copy.deepcopy(body))
            return [row]
        return []


class PublishedEpisodePersistenceTests(unittest.TestCase):
    def test_ambiguous_timeout_after_commit_does_not_create_duplicate_episode(self):
        db = FakeDatabase(commit_then_timeout=True)
        episode = {
            "owner_id": "owner-1",
            "title": "Published sports episode",
            "description": "A confirmed episode",
            "status": "published",
            "spreaker_episode_id": "76518333",
            "source_data": {"worker_job_id": "job-1", "spreaker_status": "published"},
            "published_at": "2026-11-22T08:14:02+00:00",
        }

        tenant_worker.save_worker_episode(db, episode, "job-1")

        self.assertEqual(db.insert_calls, 1)
        self.assertEqual(len(db.episodes), 1)
        self.assertEqual(db.episodes[0]["spreaker_episode_id"], "76518333")
        self.assertEqual(db.episodes[0]["status"], "published")

    def test_existing_failure_placeholder_is_replaced_not_duplicated(self):
        db = FakeDatabase()
        db.episodes.append({
            "id": "failure-row",
            "owner_id": "owner-1",
            "title": "Episode generation failed",
            "status": "failed",
            "source_data": {"worker_job_id": "job-1"},
        })
        episode = {
            "owner_id": "owner-1",
            "title": "Published sports episode",
            "description": "A confirmed episode",
            "status": "published",
            "spreaker_episode_id": "76518333",
            "source_data": {"worker_job_id": "job-1", "spreaker_status": "published"},
        }

        tenant_worker.save_worker_episode(db, episode, "job-1")

        self.assertEqual(db.insert_calls, 0)
        self.assertEqual(len(db.episodes), 1)
        self.assertEqual(db.episodes[0]["title"], "Published sports episode")
        self.assertEqual(db.episodes[0]["status"], "published")

    def test_checkpoint_preserves_manual_trial_payload(self):
        db = FakeDatabase()
        db.jobs["job-1"] = {"payload": {"source": "manual", "free_trial": True}}
        episode = {
            "owner_id": "owner-1",
            "title": "Published sports episode",
            "status": "published",
            "spreaker_episode_id": "76518333",
        }

        payload = tenant_worker.checkpoint_published_episode(
            db, "job-1", db.jobs["job-1"]["payload"], episode
        )

        self.assertEqual(payload["source"], "manual")
        self.assertTrue(payload["free_trial"])
        self.assertEqual(payload["worker_stage"], "spreaker_published")
        self.assertEqual(payload["recovery_episode"]["spreaker_episode_id"], "76518333")
        self.assertEqual(db.jobs["job-1"]["payload"], payload)


if __name__ == "__main__":
    unittest.main()
