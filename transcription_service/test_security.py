"""Security regressions; uses a stub model, never downloads Whisper weights."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ["TRANSCRIPTION_TOKEN"] = "test-token-only"

from fastapi.testclient import TestClient
import main


class SecurityTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app, base_url="http://localhost")
        self.headers = {"Authorization": "Bearer test-token-only"}

    def test_unauthenticated_upload_is_rejected_before_parsing(self):
        response = self.client.post("/transcribe", content=b"invalid multipart")
        self.assertEqual(response.status_code, 401)

    def test_missing_server_token_fails_closed(self):
        with patch.dict(os.environ, {"TRANSCRIPTION_TOKEN": ""}):
            self.assertEqual(self.client.get("/health", headers=self.headers).status_code, 401)

    def test_dns_rebinding_host_is_rejected(self):
        response = self.client.get("/health", headers={**self.headers, "Host": "evil.example"})
        self.assertEqual(response.status_code, 400)

    def test_untrusted_origin_has_no_cors_permission(self):
        response = self.client.options("/transcribe", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_body_limit_is_enforced_before_multipart_parsing(self):
        with patch.object(main, "MAX_REQUEST_BYTES", 10):
            response = self.client.post("/transcribe", headers=self.headers, files={"file": ("audio.wav", b"a" * 100)})
        self.assertEqual(response.status_code, 413)

    def test_empty_audio_is_rejected(self):
        response = self.client.post("/transcribe", headers=self.headers, files={"file": ("audio.wav", b"")})
        self.assertEqual(response.status_code, 400)

    def test_authenticated_transcription_still_works(self):
        model = SimpleNamespace(transcribe=lambda *args, **kwargs: ([SimpleNamespace(text=" hello ")], None))
        with patch.object(main, "get_model", return_value=model):
            response = self.client.post("/transcribe", headers=self.headers, files={"file": ("audio.wav", b"audio")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"text": "hello"})

    def test_model_error_does_not_expose_internal_details(self):
        with patch.object(main, "get_model", side_effect=RuntimeError("sensitive-internal-path")):
            response = self.client.post("/transcribe", headers=self.headers, files={"file": ("audio.wav", b"audio")})
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("sensitive-internal-path", response.text)


if __name__ == "__main__":
    unittest.main()
