"""Tests for the Track Splitter backend API."""
import io
import json
import os
import tempfile
import shutil
import time
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


# Valid audio file headers for MIME validation
AUDIO_HEADERS = {
    "mp3": b"ID3" + b"\x00" * 50,
    "wav": b"RIFF" + b"\x00" * 50,
    "flac": b"fLaC" + b"\x00" * 50,
    "ogg": b"OggS" + b"\x00" * 50,
    "m4a": b"\x00\x00\x00\x20ftyp" + b"\x00" * 50,
    "aac": b"\x00\x00\x00\x20ftyp" + b"\x00" * 50,
}


def make_audio_file(filename="test.mp3", content=None):
    """Create a fake audio file for upload testing with valid headers."""
    if content is None:
        ext = filename.rsplit(".", 1)[1].lower() if "." in filename else "mp3"
        content = AUDIO_HEADERS.get(ext, b"ID3" + b"\x00" * 50)
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


class TestMixValidation:
    def _upload(self, client):
        data = {"file": make_audio_file("test.mp3")}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        return resp.get_json()["jobId"]

    def test_mix_invalid_volume_string(self, client):
        job_id = self._upload(client)
        resp = client.post(
            f"/api/tracks/{job_id}/mix",
            data=json.dumps({"volumes": {"vocals": "loud"}, "format": "wav"}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        assert "Invalid volume" in resp.get_json()["error"]

    def test_mix_negative_volume(self, client):
        job_id = self._upload(client)
        resp = client.post(
            f"/api/tracks/{job_id}/mix",
            data=json.dumps({"volumes": {"vocals": -1.0}, "format": "wav"}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        assert "between 0 and 2" in resp.get_json()["error"]

    def test_mix_volume_too_high(self, client):
        job_id = self._upload(client)
        resp = client.post(
            f"/api/tracks/{job_id}/mix",
            data=json.dumps({"volumes": {"vocals": 5.0}, "format": "wav"}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        assert "between 0 and 2" in resp.get_json()["error"]

    def test_mix_null_volume(self, client):
        job_id = self._upload(client)
        resp = client.post(
            f"/api/tracks/{job_id}/mix",
            data=json.dumps({"volumes": {"vocals": None}, "format": "wav"}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        assert "Invalid volume" in resp.get_json()["error"]

    def test_mix_volumes_not_object(self, client):
        job_id = self._upload(client)
        resp = client.post(
            f"/api/tracks/{job_id}/mix",
            data=json.dumps({"volumes": [1.0, 0.5], "format": "wav"}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        assert "object" in resp.get_json()["error"].lower()

    def test_mix_valid_volumes(self, client):
        job_id = self._upload(client)
        resp = client.post(
            f"/api/tracks/{job_id}/mix",
            data=json.dumps({"volumes": {"vocals": 1.0, "drums": 0.5}, "format": "wav"}),
            content_type="application/json",
        )
        # Will return 404 (no tracks found) since we didn't process,
        # but validation should pass
        assert resp.status_code == 404
        assert "No tracks found" in resp.get_json()["error"]


class TestAudioValidation:
    def test_upload_non_audio_content(self, client):
        """Upload a .mp3 file that is actually a text file."""
        data = {"file": make_audio_file("fake.mp3", content=b"This is just plain text, not audio")}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert resp.status_code == 400
        assert "valid audio" in resp.get_json()["error"].lower()

    def test_upload_real_mp3_header(self, client):
        """Upload a file with valid MP3 ID3 header."""
        mp3_header = b"ID3" + b"\x00" * 50  # Minimal ID3 tag
        data = {"file": make_audio_file("test.mp3", content=mp3_header)}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert resp.status_code == 201

    def test_upload_real_wav_header(self, client):
        """Upload a file with valid WAV RIFF header."""
        wav_header = b"RIFF" + b"\x00" * 50
        data = {"file": make_audio_file("test.wav", content=wav_header)}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert resp.status_code == 201

    def test_upload_real_flac_header(self, client):
        """Upload a file with valid FLAC header."""
        flac_header = b"fLaC" + b"\x00" * 50
        data = {"file": make_audio_file("test.flac", content=flac_header)}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert resp.status_code == 201


class TestOrphanedJobCleanup:
    def test_orphaned_jobs_recovered(self, client):
        """Jobs stuck in uploading/queued for >1 hour should be marked as error."""
        import backend.app as app_module

        # Create a job stuck in 'queued' status from 2 hours ago
        old_time = time.time() - 7200
        conn = app_module.get_db()
        conn.execute(
            "INSERT INTO jobs (id, filename, status, tracks, progress, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("orphan_test", "test.mp3", "queued", "[]", "", old_time, old_time)
        )
        conn.commit()
        conn.close()

        # Run cleanup logic manually (extract from cleanup_old_files)
        orphan_cutoff = time.time() - 3600
        conn = app_module.get_db()
        conn.execute(
            "UPDATE jobs SET status = 'error', error = 'Job timed out waiting in queue.', updated_at = ? "
            "WHERE status IN ('uploading', 'queued') AND created_at < ?",
            (time.time(), orphan_cutoff)
        )
        conn.commit()
        conn.close()

        # Check the job is now in error state
        resp = client.get("/api/status/orphan_test")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "error"
        assert "timed out" in data["error"]


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


class TestListJobs:
    def _create_done_job(self, client, filename="test.mp3"):
        """Upload a file and manually mark as done with tracks."""
        import backend.app as app_module
        data = {"file": make_audio_file(filename)}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        job_id = resp.get_json()["jobId"]
        conn = app_module.get_db()
        conn.execute(
            "UPDATE jobs SET status = 'done', tracks = ? WHERE id = ?",
            (json.dumps([{"name": "vocals", "filename": "vocals.wav"}, {"name": "drums", "filename": "drums.wav"}]), job_id)
        )
        conn.commit()
        conn.close()
        return job_id

    def test_list_empty(self, client):
        resp = client.get("/api/jobs")
        assert resp.status_code == 200
        assert resp.get_json() == []

    def test_list_returns_done_jobs(self, client):
        job_id = self._create_done_job(client)
        resp = client.get("/api/jobs")
        assert resp.status_code == 200
        jobs = resp.get_json()
        assert len(jobs) == 1
        assert jobs[0]["id"] == job_id
        assert jobs[0]["trackCount"] == 2
        assert jobs[0]["filename"] == "test.mp3"

    def test_list_excludes_non_done(self, client):
        # Upload but don't process — status is 'uploaded'
        data = {"file": make_audio_file("test.mp3")}
        client.post("/api/upload", data=data, content_type="multipart/form-data")
        resp = client.get("/api/jobs")
        assert resp.status_code == 200
        assert len(resp.get_json()) == 0


class TestRenameJob:
    def _upload(self, client):
        data = {"file": make_audio_file("test.mp3")}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        return resp.get_json()["jobId"]

    def test_rename_success(self, client):
        job_id = self._upload(client)
        resp = client.put(
            f"/api/jobs/{job_id}/name",
            data=json.dumps({"name": "My Song"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        assert resp.get_json()["name"] == "My Song"

        # Verify via status
        resp = client.get(f"/api/status/{job_id}")
        assert resp.get_json()["name"] == "My Song"

    def test_rename_empty_name(self, client):
        job_id = self._upload(client)
        resp = client.put(
            f"/api/jobs/{job_id}/name",
            data=json.dumps({"name": "  "}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_rename_missing_job(self, client):
        resp = client.put(
            "/api/jobs/nonexistent/name",
            data=json.dumps({"name": "test"}),
            content_type="application/json",
        )
        assert resp.status_code == 404


class TestSaveSettings:
    def _upload(self, client):
        data = {"file": make_audio_file("test.mp3")}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        return resp.get_json()["jobId"]

    def test_save_and_load_settings(self, client):
        job_id = self._upload(client)
        settings = {
            "volumes": {"vocals": 0.8, "drums": 1.0},
            "mutes": {"vocals": False, "drums": True},
            "solos": {"vocals": True, "drums": False},
            "trackOrder": ["drums", "vocals"],
        }
        resp = client.put(
            f"/api/jobs/{job_id}/settings",
            data=json.dumps(settings),
            content_type="application/json",
        )
        assert resp.status_code == 200

        # Verify via status
        resp = client.get(f"/api/status/{job_id}")
        data = resp.get_json()
        assert data["mixer_settings"]["volumes"]["vocals"] == 0.8
        assert data["mixer_settings"]["trackOrder"] == ["drums", "vocals"]

    def test_save_settings_invalid_type(self, client):
        job_id = self._upload(client)
        resp = client.put(
            f"/api/jobs/{job_id}/settings",
            data=json.dumps({"volumes": "not-a-dict"}),
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_save_settings_missing_job(self, client):
        resp = client.put(
            "/api/jobs/nonexistent/settings",
            data=json.dumps({"volumes": {}}),
            content_type="application/json",
        )
        assert resp.status_code == 404


class TestDeleteJob:
    def _upload(self, client):
        data = {"file": make_audio_file("test.mp3")}
        resp = client.post("/api/upload", data=data, content_type="multipart/form-data")
        return resp.get_json()["jobId"]

    def test_delete_success(self, client):
        job_id = self._upload(client)
        resp = client.delete(f"/api/jobs/{job_id}")
        assert resp.status_code == 200
        assert resp.get_json()["deleted"] is True

        # Verify job is gone
        resp = client.get(f"/api/status/{job_id}")
        assert resp.status_code == 404

    def test_delete_missing_job(self, client):
        resp = client.delete("/api/jobs/nonexistent")
        assert resp.status_code == 404

    def test_delete_processing_job(self, client):
        import backend.app as app_module
        job_id = self._upload(client)
        conn = app_module.get_db()
        conn.execute("UPDATE jobs SET status = 'processing' WHERE id = ?", (job_id,))
        conn.commit()
        conn.close()
        resp = client.delete(f"/api/jobs/{job_id}")
        assert resp.status_code == 409


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
