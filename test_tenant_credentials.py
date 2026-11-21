"""Unit tests for per-workspace provider credential isolation.

These tests use synthetic credentials only; no real provider or platform keys
are required.
"""
from __future__ import annotations

import base64
import json
import os
import unittest

# tenant_worker reads its required environment at import time. Set harmless
# test-only values before importing it.
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SECRET_KEY", "test-only-supabase-key")
os.environ.setdefault(
    "CREDENTIAL_ENCRYPTION_KEY",
    base64.b64encode(b"test-only-32-byte-encryption-key!!").decode("ascii"),
)

import tenant_worker  # noqa: E402


class WorkspaceScopedDatabase:
    def __init__(self, rows_by_owner):
        self.rows_by_owner = rows_by_owner
        self.calls = []

    def select(self, table, **params):
        self.calls.append((table, params))
        owner_filter = params.get("owner_id", "")
        owner_id = owner_filter.removeprefix("eq.")
        return self.rows_by_owner.get(owner_id, [])


def encrypted_row(provider: str, value: str) -> dict[str, str]:
    encrypted = tenant_worker.encrypt_bundle({"credential": value})
    return {"provider": provider, **encrypted}


class CredentialIsolationTests(unittest.TestCase):
    def test_credentials_are_requested_only_for_the_current_owner(self):
        db = WorkspaceScopedDatabase({
            "customer-a": [encrypted_row("groq", "customer-a-groq-key")],
            "customer-b": [encrypted_row("groq", "customer-b-groq-key")],
        })

        a = tenant_worker.load_credentials(db, "customer-a")
        b = tenant_worker.load_credentials(db, "customer-b")

        self.assertEqual(
            json.loads(a["groq"])["credential"],
            "customer-a-groq-key",
        )
        self.assertEqual(
            json.loads(b["groq"])["credential"],
            "customer-b-groq-key",
        )
        self.assertEqual(
            [call[1]["owner_id"] for call in db.calls],
            ["eq.customer-a", "eq.customer-b"],
        )

    def test_platform_secrets_never_enter_customer_pipeline_environment(self):
        platform_values = {
            "SUPABASE_URL": "platform-url",
            "SUPABASE_SECRET_KEY": "platform-supabase-secret",
            "SUPABASE_SERVICE_ROLE_KEY": "platform-service-role",
            "CREDENTIAL_ENCRYPTION_KEY": "platform-encryption-key",
            "SPREAKER_CLIENT_ID": "platform-spreaker-client-id",
            "SPREAKER_CLIENT_SECRET": "platform-spreaker-client-secret",
            "SPREAKER_ACCESS_TOKEN": "platform-spreaker-token",
            "GROQ_API_KEY": "platform-groq-key",
            "GEMINI_API_KEY": "platform-gemini-key",
        }
        base_env = {"PATH": "/usr/bin", **platform_values}

        env = tenant_worker.build_workspace_process_env(
            base_env,
            settings={"ai_model": "model-a", "publishing_mode": "automatic"},
            selected_ai="groq",
            groq_key="customer-a-groq-key",
            gemini_key="customer-a-gemini-key",
            verified_providers={"groq", "gemini", "spreaker"},
            spreaker_token="customer-a-spreaker-token",
            show_id="show-a",
            ad_slots=[],
        )

        self.assertEqual(env["GROQ_API_KEY"], "customer-a-groq-key")
        self.assertEqual(env["GEMINI_API_KEY"], "customer-a-gemini-key")
        self.assertEqual(env["SPREAKER_ACCESS_TOKEN"], "customer-a-spreaker-token")
        self.assertEqual(env["SPREAKER_SHOW_ID"], "show-a")
        self.assertEqual(env["PATH"], "/usr/bin")
        for name in platform_values:
            self.assertNotEqual(env.get(name), platform_values[name], name)
        for name in (
            "SUPABASE_URL",
            "SUPABASE_SECRET_KEY",
            "SUPABASE_SERVICE_ROLE_KEY",
            "CREDENTIAL_ENCRYPTION_KEY",
            "SPREAKER_CLIENT_ID",
            "SPREAKER_CLIENT_SECRET",
        ):
            self.assertNotIn(name, env)

    def test_unverified_gemini_key_is_not_passed_as_groq_fallback(self):
        env = tenant_worker.build_workspace_process_env(
            {"PATH": "/usr/bin", "GEMINI_API_KEY": "platform-gemini-key"},
            settings={},
            selected_ai="groq",
            groq_key="customer-groq-key",
            gemini_key="customer-unverified-gemini-key",
            verified_providers={"groq", "spreaker"},
            spreaker_token="customer-spreaker-token",
            show_id="show-a",
            ad_slots=[],
        )

        self.assertEqual(env["GROQ_API_KEY"], "customer-groq-key")
        self.assertEqual(env["GEMINI_API_KEY"], "")

    def test_gemini_selected_uses_only_customers_gemini_key(self):
        env = tenant_worker.build_workspace_process_env(
            {
                "PATH": "/usr/bin",
                "GROQ_API_KEY": "platform-groq-key",
                "GEMINI_API_KEY": "platform-gemini-key",
            },
            settings={},
            selected_ai="gemini",
            groq_key="customer-groq-key",
            gemini_key="customer-gemini-key",
            verified_providers={"gemini", "spreaker"},
            spreaker_token="customer-spreaker-token",
            show_id="show-b",
            ad_slots=[],
        )

        self.assertEqual(env["GROQ_API_KEY"], "")
        self.assertEqual(env["GEMINI_API_KEY"], "customer-gemini-key")
        self.assertEqual(env["SPREAKER_ACCESS_TOKEN"], "customer-spreaker-token")
        self.assertEqual(env["SPREAKER_SHOW_ID"], "show-b")


if __name__ == "__main__":
    unittest.main()
