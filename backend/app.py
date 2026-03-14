import os
import uuid
import subprocess
import shutil
import tempfile
from pathlib import Path

from flask import Flask, request, jsonify, send_file, send_from_directory
from flask_cors import CORS
from werkzeug.utils import secure_filename

STATIC_DIR = Path(__file__).resolve().parent / "static"
app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")
CORS(app)

UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "../uploads"))
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "../outputs"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {"mp3", "wav", "flac", "ogg", "m4a", "wma", "aac", "webm"}
MAX_CONTENT_LENGTH = 200 * 1024 * 1024  # 200 MB

app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

# In-memory job store (swap for Redis/DB in production)
jobs: dict[str, dict] = {}


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def recover_job(job_id: str) -> dict | None:
    """Try to recover a job from disk if it exists but is not in memory."""
    job_dir = UPLOAD_DIR / job_id
    if not job_dir.is_dir():
        return None
    # Find the uploaded file
    files = [f for f in job_dir.iterdir() if f.is_file()]
    if not files:
        return None
    filename = files[0].name

    # Check if output tracks already exist
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
    }
    jobs[job_id] = job
    return job


def get_job(job_id: str) -> dict | None:
    """Get a job from memory, recovering from disk if needed."""
    job = jobs.get(job_id)
    if job:
        return job
    return recover_job(job_id)


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename or not allowed_file(file.filename):
        return jsonify({"error": f"Invalid file type. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}"}), 400

    job_id = uuid.uuid4().hex
    filename = secure_filename(file.filename)
    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    filepath = job_dir / filename

    file.save(str(filepath))

    jobs[job_id] = {
        "id": job_id,
        "filename": filename,
        "status": "uploaded",
        "tracks": [],
        "error": None,
    }

    return jsonify({"jobId": job_id, "filename": filename}), 201


@app.route("/api/split/<job_id>", methods=["POST"])
def split(job_id: str):
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    if job["status"] == "processing":
        return jsonify({"error": "Already processing"}), 409

    job["status"] = "processing"
    job["error"] = None

    input_path = UPLOAD_DIR / job_id / job["filename"]
    output_path = OUTPUT_DIR / job_id

    if output_path.exists():
        shutil.rmtree(output_path)

    model = request.json.get("model", "htdemucs") if request.is_json else "htdemucs"

    try:
        result = subprocess.run(
            [
                "python", "/app/backend/demucs_wrapper.py",
                "--out", str(output_path),
                "--name", model,
                "-n", model,
                str(input_path),
            ],
            capture_output=True,
            text=True,
            timeout=600,  # 10-minute timeout
        )

        if result.returncode != 0:
            job["status"] = "error"
            job["error"] = result.stderr[-500:] if result.stderr else "Demucs failed"
            return jsonify({"error": job["error"]}), 500

        # Discover output tracks
        stem_dir = output_path / model / input_path.stem
        if not stem_dir.exists():
            # Try to find the output directory
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
        return jsonify({"jobId": job_id, "status": "done", "tracks": tracks})

    except subprocess.TimeoutExpired:
        job["status"] = "error"
        job["error"] = "Processing timed out (10 min limit)"
        return jsonify({"error": job["error"]}), 504
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        return jsonify({"error": str(e)}), 500


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

    # Search for the file in the output directory
    output_path = OUTPUT_DIR / job_id
    matches = list(output_path.rglob(track_filename))
    if not matches:
        return jsonify({"error": "Track not found"}), 404

    return send_file(str(matches[0]), mimetype="audio/wav")


@app.route("/api/tracks/<job_id>/download-all", methods=["GET"])
def download_all(job_id: str):
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    output_path = OUTPUT_DIR / job_id
    zip_path = OUTPUT_DIR / f"{job_id}.zip"

    if zip_path.exists():
        zip_path.unlink()

    shutil.make_archive(str(zip_path.with_suffix("")), "zip", str(output_path))

    return send_file(str(zip_path), mimetype="application/zip",
                     as_attachment=True, download_name=f"{Path(job['filename']).stem}_tracks.zip")


@app.route("/api/tracks/<job_id>/mix", methods=["POST"])
def download_mix(job_id: str):
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    if not request.is_json or "volumes" not in request.json:
        return jsonify({"error": "Missing volumes map"}), 400

    volume_map = request.json["volumes"]  # e.g. {"vocals": 0.8, "drums": 1.0, "bass": 0, ...}
    output_path = OUTPUT_DIR / job_id

    # Find all track files
    track_files = []
    for track in job.get("tracks", []):
        matches = list(output_path.rglob(track["filename"]))
        if matches:
            vol = volume_map.get(track["name"], 1.0)
            track_files.append((str(matches[0]), float(vol)))

    if not track_files:
        return jsonify({"error": "No tracks found"}), 404

    # Use ffmpeg to mix tracks with individual volumes
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            mix_path = tmp.name

        # Build ffmpeg filter: apply volume to each input, then amix them
        inputs = []
        filter_parts = []
        for i, (path, vol) in enumerate(track_files):
            inputs.extend(["-i", path])
            filter_parts.append(f"[{i}]volume={vol}[v{i}]")

        mix_inputs = "".join(f"[v{i}]" for i in range(len(track_files)))
        filter_parts.append(f"{mix_inputs}amix=inputs={len(track_files)}:duration=longest:normalize=0[out]")

        filter_graph = ";".join(filter_parts)

        cmd = ["ffmpeg", "-y"] + inputs + ["-filter_complex", filter_graph, "-map", "[out]", mix_path]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            return jsonify({"error": "Mix failed: " + (result.stderr[-300:] if result.stderr else "unknown")}), 500

        original_stem = Path(job["filename"]).stem
        return send_file(
            mix_path,
            mimetype="audio/wav",
            as_attachment=True,
            download_name=f"{original_stem}_custom_mix.wav",
        )
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Mix timed out"}), 504
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/")
def index():
    if (STATIC_DIR / "index.html").is_file():
        return send_from_directory(str(STATIC_DIR), "index.html")
    return jsonify({"message": "Track Splitter API. Frontend not built — run npm run build in frontend/."}), 200


@app.errorhandler(404)
def not_found(e):
    # Only serve index.html for navigation routes (SPA fallback).
    # Do NOT intercept requests for static assets — let them return a real 404
    # so the browser can report the missing file instead of silently failing.
    path = request.path
    if path.startswith("/static/") or path.startswith("/api/") or "." in path.split("/")[-1]:
        return jsonify({"error": "Not found"}), 404
    if (STATIC_DIR / "index.html").is_file():
        return send_from_directory(str(STATIC_DIR), "index.html")
    return jsonify({"error": "Not found"}), 404


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
