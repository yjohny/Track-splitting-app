import os
import uuid
import subprocess
import shutil
from pathlib import Path

from flask import Flask, request, jsonify, send_file, send_from_directory
from flask_cors import CORS
from werkzeug.utils import secure_filename

STATIC_DIR = Path(__file__).parent / "static"
app = Flask(__name__, static_folder=str(STATIC_DIR) if STATIC_DIR.exists() else None)
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
    job = jobs.get(job_id)
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
                "python", "-m", "demucs",
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
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify(job)


@app.route("/api/tracks/<job_id>/<track_filename>", methods=["GET"])
def download_track(job_id: str, track_filename: str):
    job = jobs.get(job_id)
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
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    output_path = OUTPUT_DIR / job_id
    zip_path = OUTPUT_DIR / f"{job_id}.zip"

    if zip_path.exists():
        zip_path.unlink()

    shutil.make_archive(str(zip_path.with_suffix("")), "zip", str(output_path))

    return send_file(str(zip_path), mimetype="application/zip",
                     as_attachment=True, download_name=f"{Path(job['filename']).stem}_tracks.zip")


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_frontend(path):
    if STATIC_DIR.exists():
        file_path = STATIC_DIR / path
        if file_path.is_file():
            return send_from_directory(str(STATIC_DIR), path)
        return send_from_directory(str(STATIC_DIR), "index.html")
    return jsonify({"message": "Track Splitter API. Frontend not built — run npm run build in frontend/."}), 200


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
