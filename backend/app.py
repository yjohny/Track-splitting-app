import os
import re
import uuid
import subprocess
import shutil
import tempfile
import threading
import time
import queue
import sqlite3
import json
from pathlib import Path
from functools import wraps

from flask import Flask, request, jsonify, send_file, send_from_directory, Response, stream_with_context, after_this_request
from flask_cors import CORS
from werkzeug.utils import secure_filename

STATIC_DIR = Path(__file__).resolve().parent / "static"
app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")
CORS(app, origins=os.environ.get("ALLOWED_ORIGINS", "*").split(","))

UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "../uploads"))
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "../outputs"))
DB_PATH = Path(os.environ.get("DB_PATH", "../data/jobs.db"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {"mp3", "wav", "flac", "ogg", "m4a", "wma", "aac", "webm"}
MAX_CONTENT_LENGTH = 200 * 1024 * 1024  # 200 MB
CLEANUP_MAX_AGE_HOURS = int(os.environ.get("CLEANUP_MAX_AGE_HOURS", "24"))
RATE_LIMIT_MAX = int(os.environ.get("RATE_LIMIT_MAX", "10"))
RATE_LIMIT_WINDOW = int(os.environ.get("RATE_LIMIT_WINDOW", "3600"))  # seconds

app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH


def get_device():
    """Auto-detect best available device for Demucs inference."""
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


# ---- SQLite Job Store ----

def get_db():
    """Get a thread-local SQLite connection."""
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    """Initialize the database schema."""
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'uploaded',
            tracks TEXT NOT NULL DEFAULT '[]',
            error TEXT,
            progress TEXT DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS rate_limits (
            ip TEXT NOT NULL,
            timestamp REAL NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rate_limits_ip ON rate_limits(ip)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at)")
    conn.commit()
    conn.close()


def db_save_job(job: dict):
    """Save or update a job in the database."""
    conn = get_db()
    conn.execute("""
        INSERT INTO jobs (id, filename, status, tracks, error, progress, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status=excluded.status, tracks=excluded.tracks,
            error=excluded.error, progress=excluded.progress,
            updated_at=excluded.updated_at
    """, (
        job["id"], job["filename"], job["status"],
        json.dumps(job.get("tracks", [])), job.get("error"),
        job.get("progress", ""), job.get("created_at", time.time()), time.time()
    ))
    conn.commit()
    conn.close()


def db_get_job(job_id: str) -> dict | None:
    """Get a job from the database."""
    conn = get_db()
    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    conn.close()
    if not row:
        return None
    return {
        "id": row["id"],
        "filename": row["filename"],
        "status": row["status"],
        "tracks": json.loads(row["tracks"]),
        "error": row["error"],
        "progress": row["progress"] or "",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def db_update_progress(job_id: str, progress: str):
    """Update just the progress field for a job."""
    conn = get_db()
    conn.execute("UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?",
                 (progress, time.time(), job_id))
    conn.commit()
    conn.close()


def _format_eta(eta_str: str) -> str:
    """Turn a tqdm ETA like '01:44' or '1:02:30' into a human-friendly string."""
    parts = eta_str.strip().split(":")
    try:
        if len(parts) == 3:
            h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
        elif len(parts) == 2:
            h, m, s = 0, int(parts[0]), int(parts[1])
        else:
            return eta_str
    except ValueError:
        return eta_str

    if h > 0:
        return f"{h}h {m}m" if m else f"{h}h"
    if m > 0:
        return f"{m}m {s}s" if s else f"{m}m"
    return f"{s}s"


def format_progress(line: str) -> str:
    """Clean up raw tqdm/demucs progress output for user-friendly display.

    Turns e.g. '21%|████| 52.65/251.54999999999998 [00:29<01:44, 1.90seconds/s]'
    into '21% — about 1m 44s remaining'
    """
    m = re.match(
        r"(\d+)%\|[^|]*\|\s*[\d.]+/[\d.]+\s*\[[^<]*<([^,\]]+)",
        line,
    )
    if not m:
        return line

    pct = int(m.group(1))
    eta_raw = m.group(2)  # e.g. "01:44"
    eta = _format_eta(eta_raw)

    if pct >= 100:
        return "100% — wrapping up..."
    return f"{pct}% — about {eta} remaining"


# ---- SSE Progress Events ----
# Per-job event channels for SSE streaming
_progress_events: dict[str, list] = {}  # job_id -> list of subscriber queues
_progress_lock = threading.Lock()


def publish_progress(job_id: str, data: dict):
    """Publish a progress event to all SSE subscribers for a job."""
    with _progress_lock:
        subscribers = _progress_events.get(job_id, [])
        for q in subscribers:
            q.put(data)


def subscribe_progress(job_id: str) -> queue.Queue:
    """Subscribe to progress events for a job."""
    q = queue.Queue()
    with _progress_lock:
        if job_id not in _progress_events:
            _progress_events[job_id] = []
        _progress_events[job_id].append(q)
    return q


def unsubscribe_progress(job_id: str, q: queue.Queue):
    """Unsubscribe from progress events."""
    with _progress_lock:
        if job_id in _progress_events:
            _progress_events[job_id] = [s for s in _progress_events[job_id] if s is not q]
            if not _progress_events[job_id]:
                del _progress_events[job_id]


# ---- Processing Queue ----
_job_queue = queue.Queue()


def process_worker():
    """Background worker that processes jobs one at a time."""
    while True:
        job_id, model = _job_queue.get()
        try:
            _run_split(job_id, model)
        except Exception as e:
            job = db_get_job(job_id)
            if job:
                job["status"] = "error"
                job["error"] = str(e)
                db_save_job(job)
                publish_progress(job_id, {"status": "error", "error": str(e)})
        finally:
            _job_queue.task_done()


def _run_split(job_id: str, model: str):
    """Run demucs separation with progress streaming."""
    job = db_get_job(job_id)
    if not job:
        return

    input_path = UPLOAD_DIR / job_id / job["filename"]
    output_path = OUTPUT_DIR / job_id

    if output_path.exists():
        shutil.rmtree(output_path)

    publish_progress(job_id, {"status": "processing", "progress": "Starting separation..."})

    try:
        process = subprocess.Popen(
            [
                "python", "-u",
                str(Path(__file__).resolve().parent / "demucs_wrapper.py"),
                "-d", get_device(),
                "--out", str(output_path),
                "--name", model,
                "-n", model,
                str(input_path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        # Stream stderr for progress updates (demucs writes progress to stderr)
        start_time = time.time()
        for line in iter(process.stderr.readline, ""):
            line = line.strip()
            if not line:
                continue
            # Parse demucs progress (typically shows percentage)
            if "%" in line:
                progress_text = format_progress(line)
            elif "Separated" in line or "separated" in line:
                progress_text = "Finalizing..."
            else:
                progress_text = line

            db_update_progress(job_id, progress_text)
            publish_progress(job_id, {"status": "processing", "progress": progress_text})

            if time.time() - start_time > 600:
                process.kill()
                raise TimeoutError("Processing timed out (10 min limit)")

        process.wait(timeout=30)

        if process.returncode != 0:
            stdout = process.stdout.read() if process.stdout else ""
            error_msg = f"Demucs failed (exit code {process.returncode})"
            if stdout:
                error_msg += f": {stdout[-500:]}"
            raise RuntimeError(error_msg)

        # Discover output tracks
        stem_dir = output_path / model / input_path.stem
        if not stem_dir.exists():
            for candidate in output_path.rglob("*.wav"):
                stem_dir = candidate.parent
                break

        tracks = []
        if stem_dir and stem_dir.exists():
            for track_file in sorted(stem_dir.iterdir()):
                if track_file.suffix in (".wav", ".mp3", ".flac"):
                    tracks.append({
                        "name": track_file.stem,
                        "filename": track_file.name,
                    })

        job["status"] = "done"
        job["tracks"] = tracks
        job["progress"] = ""
        db_save_job(job)
        publish_progress(job_id, {"status": "done", "tracks": tracks})

    except TimeoutError as e:
        job["status"] = "error"
        job["error"] = str(e)
        db_save_job(job)
        publish_progress(job_id, {"status": "error", "error": str(e)})
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        db_save_job(job)
        publish_progress(job_id, {"status": "error", "error": str(e)})


# ---- File Cleanup ----
def cleanup_old_files():
    """Periodically remove files older than CLEANUP_MAX_AGE_HOURS."""
    while True:
        time.sleep(3600)  # Check every hour
        try:
            cutoff = time.time() - (CLEANUP_MAX_AGE_HOURS * 3600)

            conn = get_db()
            old_jobs = conn.execute(
                "SELECT id FROM jobs WHERE created_at < ? AND status != 'processing'",
                (cutoff,)
            ).fetchall()
            conn.close()

            for row in old_jobs:
                job_id = row["id"]
                upload_dir = UPLOAD_DIR / job_id
                output_dir = OUTPUT_DIR / job_id
                zip_path = OUTPUT_DIR / f"{job_id}.zip"

                if upload_dir.exists():
                    shutil.rmtree(upload_dir)
                if output_dir.exists():
                    shutil.rmtree(output_dir)
                if zip_path.exists():
                    zip_path.unlink()

                conn = get_db()
                conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
                conn.commit()
                conn.close()

            # Recover orphaned jobs stuck in uploading/queued for more than 1 hour
            orphan_cutoff = time.time() - 3600
            conn = get_db()
            conn.execute(
                "UPDATE jobs SET status = 'error', error = 'Job timed out waiting in queue.', updated_at = ? "
                "WHERE status IN ('uploading', 'queued') AND created_at < ?",
                (time.time(), orphan_cutoff)
            )
            conn.commit()
            conn.close()

        except Exception as e:
            print(f"Cleanup error: {e}")


# ---- Rate Limiting ----
def check_rate_limit(ip: str) -> bool:
    """Check if an IP has exceeded the rate limit. Returns True if allowed."""
    conn = get_db()
    cutoff = time.time() - RATE_LIMIT_WINDOW
    # Clean old entries
    conn.execute("DELETE FROM rate_limits WHERE timestamp < ?", (cutoff,))
    count = conn.execute(
        "SELECT COUNT(*) as cnt FROM rate_limits WHERE ip = ? AND timestamp > ?",
        (ip, cutoff)
    ).fetchone()["cnt"]
    conn.commit()
    conn.close()
    return count < RATE_LIMIT_MAX


def record_request(ip: str):
    """Record a request for rate limiting."""
    conn = get_db()
    conn.execute("INSERT INTO rate_limits (ip, timestamp) VALUES (?, ?)", (ip, time.time()))
    conn.commit()
    conn.close()


def rate_limited(f):
    """Decorator to rate-limit an endpoint."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        ip = request.remote_addr or "unknown"
        if not check_rate_limit(ip):
            return jsonify({
                "error": f"Rate limit exceeded. Maximum {RATE_LIMIT_MAX} uploads per hour."
            }), 429
        record_request(ip)
        return f(*args, **kwargs)
    return wrapper


# ---- Helpers ----

AUDIO_MAGIC_BYTES = {
    b"ID3": "mp3",         # MP3 with ID3 tag
    b"\xff\xfb": "mp3",   # MP3 frame sync
    b"\xff\xf3": "mp3",   # MP3 frame sync
    b"\xff\xf2": "mp3",   # MP3 frame sync
    b"RIFF": "wav",        # WAV
    b"fLaC": "flac",       # FLAC
    b"OggS": "ogg",        # OGG
    b"\x1aE\xdf\xa3": "webm",  # WebM/Matroska
}


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def validate_audio_content(filepath: Path) -> bool:
    """Check file header bytes to verify it looks like an audio file."""
    try:
        with open(filepath, "rb") as f:
            header = f.read(12)
        if len(header) < 4:
            return False
        # Check known audio signatures
        for magic, _ in AUDIO_MAGIC_BYTES.items():
            if header[:len(magic)] == magic:
                return True
        # M4A/AAC/MP4 container: check for 'ftyp' at byte 4
        if header[4:8] == b"ftyp":
            return True
        # WMA: ASF header
        if header[:4] == b"\x30\x26\xb2\x75":
            return True
        return False
    except OSError:
        return False


def get_job(job_id: str) -> dict | None:
    """Get a job from the database, with disk recovery fallback."""
    job = db_get_job(job_id)
    if job:
        return job

    # Try to recover from disk
    job_dir = UPLOAD_DIR / job_id
    if not job_dir.is_dir():
        return None
    files = [f for f in job_dir.iterdir() if f.is_file()]
    if not files:
        return None

    filename = files[0].name
    output_path = OUTPUT_DIR / job_id
    tracks = []
    status = "uploaded"
    if output_path.exists():
        for candidate in output_path.rglob("*.wav"):
            tracks.append({"name": candidate.stem, "filename": candidate.name})
        if tracks:
            status = "done"

    job = {
        "id": job_id,
        "filename": filename,
        "status": status,
        "tracks": sorted(tracks, key=lambda t: t["name"]),
        "error": None,
        "progress": "",
        "created_at": time.time(),
    }
    db_save_job(job)
    return job


EXPORT_FORMATS = {
    "wav": {"ext": ".wav", "codec": [], "mimetype": "audio/wav"},
    "mp3": {"ext": ".mp3", "codec": ["-codec:a", "libmp3lame", "-b:a", "320k"], "mimetype": "audio/mpeg"},
    "flac": {"ext": ".flac", "codec": ["-codec:a", "flac"], "mimetype": "audio/flac"},
}


# ---- Routes ----

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "queue_size": _job_queue.qsize()})


@app.route("/api/upload", methods=["POST"])
@rate_limited
def upload():
    if "file" not in request.files:
        return jsonify({"error": "No file provided. Please select an audio file to upload."}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "No filename provided. The file appears to be empty or invalid."}), 400

    if not allowed_file(file.filename):
        ext = file.filename.rsplit(".", 1)[1].lower() if "." in file.filename else "unknown"
        return jsonify({
            "error": f"Unsupported file format '.{ext}'. Supported formats: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        }), 400

    job_id = uuid.uuid4().hex
    filename = secure_filename(file.filename)
    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    filepath = job_dir / filename

    file.save(str(filepath))

    # Validate file is actually audio (check file size > 0)
    if filepath.stat().st_size == 0:
        shutil.rmtree(job_dir)
        return jsonify({"error": "The uploaded file is empty. Please select a valid audio file."}), 400

    if not validate_audio_content(filepath):
        shutil.rmtree(job_dir)
        return jsonify({"error": "The file does not appear to be a valid audio file. Please upload a real audio file."}), 400

    job = {
        "id": job_id,
        "filename": filename,
        "status": "uploaded",
        "tracks": [],
        "error": None,
        "progress": "",
        "created_at": time.time(),
    }
    db_save_job(job)

    return jsonify({"jobId": job_id, "filename": filename}), 201


@app.route("/api/split/<job_id>", methods=["POST"])
def split(job_id: str):
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found. The upload may have expired or the ID is invalid."}), 404

    if job["status"] == "processing":
        return jsonify({"error": "This file is already being processed. Please wait for it to finish."}), 409

    if job["status"] == "queued":
        return jsonify({"error": "This file is already in the processing queue."}), 409

    model = request.json.get("model", "htdemucs") if request.is_json else "htdemucs"
    valid_models = ["htdemucs", "htdemucs_6s"]
    if model not in valid_models:
        return jsonify({
            "error": f"Invalid model '{model}'. Available models: {', '.join(valid_models)}"
        }), 400

    job["status"] = "queued"
    job["error"] = None
    job["progress"] = "Waiting in queue..."
    db_save_job(job)

    _job_queue.put((job_id, model))

    queue_pos = _job_queue.qsize()
    return jsonify({
        "jobId": job_id,
        "status": "queued",
        "queuePosition": queue_pos,
        "message": f"Added to processing queue (position {queue_pos})"
    })


@app.route("/api/progress/<job_id>", methods=["GET"])
def progress_stream(job_id: str):
    """SSE endpoint for real-time progress updates."""
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    def generate():
        q = subscribe_progress(job_id)
        try:
            # Send current status immediately
            current = db_get_job(job_id)
            if current:
                yield f"data: {json.dumps({'status': current['status'], 'progress': current.get('progress', ''), 'tracks': current.get('tracks', [])})}\n\n"

                if current["status"] in ("done", "error"):
                    return

            while True:
                try:
                    data = q.get(timeout=30)
                    yield f"data: {json.dumps(data)}\n\n"
                    if data.get("status") in ("done", "error"):
                        break
                except queue.Empty:
                    # Send keepalive
                    yield f": keepalive\n\n"
        finally:
            unsubscribe_progress(job_id, q)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        }
    )


@app.route("/api/status/<job_id>", methods=["GET"])
def status(job_id: str):
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify(job)


@app.route("/api/tracks/<job_id>/<track_filename>", methods=["GET"])
def download_track(job_id: str, track_filename: str):
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    track_filename = secure_filename(track_filename)
    output_path = OUTPUT_DIR / job_id
    matches = list(output_path.rglob(track_filename))
    if not matches:
        return jsonify({"error": f"Track '{track_filename}' not found. It may have been cleaned up."}), 404

    # Support format conversion via query param
    fmt = request.args.get("format", "wav").lower()
    if fmt not in EXPORT_FORMATS:
        return jsonify({"error": f"Unsupported format '{fmt}'. Available: {', '.join(EXPORT_FORMATS.keys())}"}), 400

    source_path = str(matches[0])

    if fmt == "wav":
        return send_file(source_path, mimetype="audio/wav", conditional=True)

    # Convert using ffmpeg
    format_info = EXPORT_FORMATS[fmt]
    with tempfile.NamedTemporaryFile(suffix=format_info["ext"], delete=False) as tmp:
        converted_path = tmp.name

    try:
        cmd = ["ffmpeg", "-y", "-i", source_path] + format_info["codec"] + [converted_path]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            os.unlink(converted_path)
            return jsonify({"error": "Format conversion failed"}), 500

        @after_this_request
        def _cleanup(response):
            try:
                os.unlink(converted_path)
            except OSError:
                pass
            return response

        download_name = Path(track_filename).stem + format_info["ext"]
        return send_file(
            converted_path,
            mimetype=format_info["mimetype"],
            as_attachment=True,
            download_name=download_name,
        )
    except subprocess.TimeoutExpired:
        try:
            os.unlink(converted_path)
        except OSError:
            pass
        return jsonify({"error": "Format conversion timed out"}), 504


@app.route("/api/tracks/<job_id>/download-all", methods=["GET"])
def download_all(job_id: str):
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    fmt = request.args.get("format", "wav").lower()
    if fmt not in EXPORT_FORMATS:
        return jsonify({"error": f"Unsupported format '{fmt}'. Available: {', '.join(EXPORT_FORMATS.keys())}"}), 400

    output_path = OUTPUT_DIR / job_id

    if fmt == "wav":
        zip_path = OUTPUT_DIR / f"{job_id}.zip"
        if zip_path.exists():
            zip_path.unlink()
        shutil.make_archive(str(zip_path.with_suffix("")), "zip", str(output_path))
        return send_file(str(zip_path), mimetype="application/zip",
                         as_attachment=True, download_name=f"{Path(job['filename']).stem}_tracks.zip")

    # Convert all tracks to requested format, then zip
    format_info = EXPORT_FORMATS[fmt]
    with tempfile.TemporaryDirectory() as tmpdir:
        for track in job.get("tracks", []):
            matches = list(output_path.rglob(track["filename"]))
            if matches:
                out_name = Path(track["filename"]).stem + format_info["ext"]
                out_path = os.path.join(tmpdir, out_name)
                cmd = ["ffmpeg", "-y", "-i", str(matches[0])] + format_info["codec"] + [out_path]
                subprocess.run(cmd, capture_output=True, timeout=120)

        zip_base = str(OUTPUT_DIR / f"{job_id}_{fmt}")
        shutil.make_archive(zip_base, "zip", tmpdir)
        zip_path = zip_base + ".zip"
        return send_file(zip_path, mimetype="application/zip",
                         as_attachment=True,
                         download_name=f"{Path(job['filename']).stem}_tracks_{fmt}.zip")


@app.route("/api/tracks/<job_id>/mix", methods=["POST"])
def download_mix(job_id: str):
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    if not request.is_json or "volumes" not in request.json:
        return jsonify({"error": "Missing volumes map. Send JSON with a 'volumes' object mapping track names to volume levels."}), 400

    volume_map = request.json["volumes"]
    if not isinstance(volume_map, dict):
        return jsonify({"error": "Volumes must be an object mapping track names to numeric levels."}), 400
    for name, vol in volume_map.items():
        try:
            v = float(vol)
        except (TypeError, ValueError):
            return jsonify({"error": f"Invalid volume value for track '{name}'. Must be a number."}), 400
        if v < 0 or v > 2:
            return jsonify({"error": f"Volume for '{name}' must be between 0 and 2."}), 400

    fmt = request.json.get("format", "wav").lower()
    if fmt not in EXPORT_FORMATS:
        return jsonify({"error": f"Unsupported format '{fmt}'. Available: {', '.join(EXPORT_FORMATS.keys())}"}), 400

    output_path = OUTPUT_DIR / job_id
    format_info = EXPORT_FORMATS[fmt]

    track_files = []
    for track in job.get("tracks", []):
        matches = list(output_path.rglob(track["filename"]))
        if matches:
            vol = volume_map.get(track["name"], 1.0)
            track_files.append((str(matches[0]), float(vol)))

    if not track_files:
        return jsonify({"error": "No tracks found for this job. They may have been cleaned up."}), 404

    try:
        with tempfile.NamedTemporaryFile(suffix=format_info["ext"], delete=False) as tmp:
            mix_path = tmp.name

        inputs = []
        filter_parts = []
        num_tracks = len(track_files)
        for i, (path, vol) in enumerate(track_files):
            inputs.extend(["-i", path])
            # Scale each track volume by 1/num_tracks to prevent clipping when summed
            scaled_vol = vol / max(1, num_tracks)
            filter_parts.append(f"[{i}]volume={scaled_vol}[v{i}]")

        mix_inputs = "".join(f"[v{i}]" for i in range(num_tracks))
        filter_parts.append(f"{mix_inputs}amix=inputs={num_tracks}:duration=longest:dropout_transition=0:normalize=0[out]")

        filter_graph = ";".join(filter_parts)

        cmd = ["ffmpeg", "-y"] + inputs + ["-filter_complex", filter_graph, "-map", "[out]"] + format_info["codec"] + [mix_path]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            os.unlink(mix_path)
            return jsonify({"error": "Mix failed. This might happen with very long tracks or unusual audio formats."}), 500

        @after_this_request
        def _cleanup(response):
            try:
                os.unlink(mix_path)
            except OSError:
                pass
            return response

        original_stem = Path(job["filename"]).stem
        return send_file(
            mix_path,
            mimetype=format_info["mimetype"],
            as_attachment=True,
            download_name=f"{original_stem}_custom_mix{format_info['ext']}",
        )
    except subprocess.TimeoutExpired:
        try:
            os.unlink(mix_path)
        except OSError:
            pass
        return jsonify({"error": "Mix timed out. The track may be too long to process."}), 504
    except Exception as e:
        try:
            os.unlink(mix_path)
        except OSError:
            pass
        return jsonify({"error": f"Mix failed: {str(e)}"}), 500


@app.route("/")
def index():
    if (STATIC_DIR / "index.html").is_file():
        return send_from_directory(str(STATIC_DIR), "index.html")
    return jsonify({"message": "Track Splitter API. Frontend not built — run npm run build in frontend/."}), 200


@app.errorhandler(404)
def not_found(e):
    path = request.path
    if path.startswith("/static/") or path.startswith("/api/") or "." in path.split("/")[-1]:
        return jsonify({"error": "Not found"}), 404
    if (STATIC_DIR / "index.html").is_file():
        return send_from_directory(str(STATIC_DIR), "index.html")
    return jsonify({"error": "Not found"}), 404


# ---- Startup ----

init_db()

# Start the processing worker thread
_worker_thread = threading.Thread(target=process_worker, daemon=True)
_worker_thread.start()

# Start the cleanup thread
_cleanup_thread = threading.Thread(target=cleanup_old_files, daemon=True)
_cleanup_thread.start()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
