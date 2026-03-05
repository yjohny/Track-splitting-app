# Track Splitter

A web app that splits music files into individual instrument tracks using AI (Meta's [Demucs](https://github.com/facebookresearch/demucs) model).

Upload a song and get back separate tracks for **vocals, drums, bass, guitar, piano**, and more.

## Features

- Drag-and-drop file upload (MP3, WAV, FLAC, OGG, M4A, AAC up to 200 MB)
- Two separation models:
  - **HTDemucs** — 4 stems: vocals, drums, bass, other
  - **HTDemucs 6-stem** — 6 stems: vocals, drums, bass, guitar, piano, other
- In-browser playback with per-track play/pause/mute
- Download individual tracks or all as a ZIP

## Quick Start with Docker

```bash
docker compose up --build
```

Then open [http://localhost:5000](http://localhost:5000).

## Manual Setup

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```

Requires `ffmpeg` on your system (`apt install ffmpeg` / `brew install ffmpeg`).

### Frontend

```bash
cd frontend
npm install
npm start
```

The React dev server proxies API requests to `localhost:5000`.

## Architecture

```
frontend/          React SPA (upload UI, track player)
backend/
  app.py           Flask API (upload, split via Demucs, serve tracks)
Dockerfile         Multi-stage build (Node + Python)
docker-compose.yml One-command deployment
```

## How It Works

1. User uploads an audio file via the web UI
2. Backend saves the file and runs Demucs source separation
3. Demucs outputs one WAV per stem (vocals, drums, bass, etc.)
4. Frontend fetches and plays each track individually
5. User can download individual tracks or a ZIP of all tracks

## Requirements

- Python 3.10+
- Node.js 18+
- ffmpeg
- ~4 GB RAM for processing (GPU optional but faster)
