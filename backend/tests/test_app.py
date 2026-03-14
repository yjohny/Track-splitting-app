"""Tests for the Track Splitter backend API."""
import io
import json
import os
import tempfile
import shutil
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Set temp dirs before importing app
_test_dir = tempfile.mkdtemp()
os.environ["UPLOAD_DIR"] = os.path.join(_test_dir, "uploads")
os.environ["OUTPUT_DIR"] = os.path.join(_test_dir, "outputs")
os.environ["DB_PATH"] = os.path.join(_test_dir, "data", "test_jobs.db")
os.environ["RATE_LIMIT_MAX"] = "100"  # High limit for tests

from backend.app import app, get_db, init_db  # noqa: E402


@pytest.fixture(autouse=True)
def setup_teardown():
    """Set up and tear down test directories."""
    os.makedirs(os.environ["UPLOAD_DIR"], exist_ok=True)
    os.makedirs(os.environ["OUTPUT_DIR"], exist_ok=True)
    os.makedirs(os.path.dirname(os.environ["DB_PATH"]), exist_ok=True)
    init_db()
    yield
    # Clean up between tests
    conn = get_db()
    conn.execute("DELETE FROM jobs")
    conn.execute("DELETE FROM rate_limits")
    conn.commit()
    conn.close()


@pytest.fixture
def client():
    """Create a test client."""
    app.config["TESTING"] = True
    with app.test_client() as client:
        yield client


def make_audio_file(filename="test.mp3", content=b"fake audio content"):
    """Create a fake audio file for upload testing."""
    return (io.BytesIO(content), filename)


class TestHealth:
    def test_health_check(self, client):
        resp = client.get("/api/health")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "ok"
        assert "queue_size" in data


class TestUpload:
    def test_upload_success(self, client):
        data = {"file": make_audio_file("test.mp3")}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert resp.status_code == 201
        result = resp.get_json()
        assert "jobId" in result
        assert result["filename"] == "test.mp3"

    def test_upload_no_file(self, client):
        resp = client.post("/api/upload", data={}, content_type="multipart/form-data")
        assert resp.status_code == 400
        assert "No file provided" in resp.get_json()["error"]

    def test_upload_invalid_extension(self, client):
        data = {"file": make_audio_file("test.exe")}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert resp.status_code == 400
        assert "Unsupported file format" in resp.get_json()["error"]

    def test_upload_empty_file(self, client):
        data = {"file": make_audio_file("test.mp3", content=b"")}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert resp.status_code == 400
        assert "empty" in resp.get_json()["error"].lower()

    def test_upload_various_formats(self, client):
        for ext in ["mp3", "wav", "flac", "ogg", "m4a", "aac"]:
            data = {"file": make_audio_file(f"test.{ext}")}
            resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
            assert resp.status_code == 201, f"Failed for .{ext}"


class TestSplit:
    def _upload(self, client):
        data = {"file": make_audio_file("test.mp3")}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        return resp.get_json()["jobId"]

    def test_split_queues_job(self, client):
        job_id = self._upload(client)
        resp = client.post(
            f"/api/split/{job_id}",
            data=json.dumps({"model": "htdemucs"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        result = resp.get_json()
        assert result["status"] == "queued"

    def test_split_invalid_job(self, client):
        resp = client.post(
            "/api/split/nonexistent",
            data=json.dumps({"model": "htdemucs"}),
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_split_invalid_model(self, client):
        job_id = self._upload(client)
        resp = client.post(
            f"/api/split/{job_id}",
            data=json.dumps({"model": "invalid_model"}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        assert "Invalid model" in resp.get_json()["error"]

    def test_split_duplicate(self, client):
        job_id = self._upload(client)
        # First split
        client.post(
            f"/api/split/{job_id}",
            data=json.dumps({"model": "htdemucs"}),
            content_type="application/json",
        )
        # Second split should fail (already queued)
        resp = client.post(
            f"/api/split/{job_id}",
            data=json.dumps({"model": "htdemucs"}),
            content_type="application/json",
        )
        assert resp.status_code == 409


class TestStatus:
    def test_status_after_upload(self, client):
        data = {"file": make_audio_file("test.mp3")}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        job_id = resp.get_json()["jobId"]

        resp = client.get(f"/api/status/{job_id}")
        assert resp.status_code == 200
        result = resp.get_json()
        assert result["status"] == "uploaded"

    def test_status_not_found(self, client):
        resp = client.get("/api/status/nonexistent")
        assert resp.status_code == 404


class TestTracks:
    def test_download_track_not_found(self, client):
        resp = client.get("/api/tracks/nonexistent/vocals.wav")
        assert resp.status_code == 404

    def test_download_all_not_found(self, client):
        resp = client.get("/api/tracks/nonexistent/download-all")
        assert resp.status_code == 404

    def test_invalid_export_format(self, client):
        data = {"file": make_audio_file("test.mp3")}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        job_id = resp.get_json()["jobId"]
        resp = client.get(f"/api/tracks/{job_id}/download-all?format=aiff")
        assert resp.status_code == 400
        assert "Unsupported format" in resp.get_json()["error"]


class TestMix:
    def test_mix_missing_volumes(self, client):
        data = {"file": make_audio_file("test.mp3")}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        job_id = resp.get_json()["jobId"]

        resp = client.post(
            f"/api/tracks/{job_id}/mix",
            data=json.dumps({}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        assert "Missing volumes" in resp.get_json()["error"]

    def test_mix_invalid_format(self, client):
        data = {"file": make_audio_file("test.mp3")}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        job_id = resp.get_json()["jobId"]

        resp = client.post(
            f"/api/tracks/{job_id}/mix",
            data=json.dumps({"volumes": {"vocals": 1.0}, "format": "aiff"}),
            content_type="application/json",
        )
        assert resp.status_code == 400


class TestRateLimit:
    def test_rate_limit_enforced(self, client):
        # Override to a low limit for this test
        original = os.environ.get("RATE_LIMIT_MAX", "100")
        import backend.app as app_module
        old_limit = app_module.RATE_LIMIT_MAX
        app_module.RATE_LIMIT_MAX = 2

        try:
            # First two should succeed
            for _ in range(2):
                data = {"file": make_audio_file("test.mp3")}
                resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
                assert resp.status_code == 201

            # Third should be rate-limited
            data = {"file": make_audio_file("test.mp3")}
            resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
            assert resp.status_code == 429
            assert "Rate limit" in resp.get_json()["error"]
        finally:
            app_module.RATE_LIMIT_MAX = old_limit


class TestSPAFallback:
    def test_api_404(self, client):
        resp = client.get("/api/nonexistent")
        assert resp.status_code == 404

    def test_static_asset_404(self, client):
        resp = client.get("/static/nonexistent.js")
        assert resp.status_code == 404


@pytest.fixture(scope="session", autouse=True)
def cleanup_test_dir():
    """Remove test directory after all tests."""
    yield
    shutil.rmtree(_test_dir, ignore_errors=True)
