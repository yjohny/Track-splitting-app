# CLAUDE.md

## Project overview

Track Splitter — a web app that splits audio files into individual instrument tracks using Meta's Demucs model. Flask backend, React/TypeScript frontend, deployable via Docker.

## Architecture

- `backend/app.py` — Flask API: file upload, job queue, Demucs subprocess runner, SSE progress streaming, track serving, persistent job library. `get_device()` auto-detects GPU (CUDA → MPS → CPU fallback) for Demucs inference. SQLite (`../data/jobs.db`) stores job metadata, custom names, and mixer settings.
- `backend/demucs_wrapper.py` — Demucs subprocess helper; patches `torchaudio.save` to fall back to soundfile when torchcodec is unavailable.
- `frontend/src/App.tsx` — Single-file React SPA: upload flow, mixer/player UI, drag-to-reorder tracks, persistent library view with navigation tabs
- `frontend/src/types.ts` — Shared TypeScript interfaces (`Track`, `MixerSettings`, `LibraryJob`, etc.)

Progress flows from demucs stderr → `format_progress()` in app.py → SSE → frontend `ProgressDisplay` component.

Audio playback: each track is an `HTMLAudioElement` with native `.volume` control. Master gain uses `1/sqrt(n)` scaling across audible tracks.

### Persistence

- Jobs persist in SQLite until the user explicitly deletes them (no auto-cleanup).
- Mixer settings (volumes, mutes, solos, track order) auto-save to the backend (debounced 1s) via `PUT /api/jobs/:id/settings` and restore when reopening from the library.
- Users can rename splits via inline editing (`PUT /api/jobs/:id/name`).
- Library endpoint: `GET /api/jobs` returns all completed jobs. Delete via `DELETE /api/jobs/:id`.

## Commands

### Backend
```bash
cd backend && python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python app.py                    # runs on :5000
pytest tests/                    # backend tests
```

### Frontend
```bash
cd frontend
npm install
npm start                        # dev server, proxies API to :5000
npm test                         # jest + react-testing-library
npm run build                    # production build → backend/static/
```

### Docker
```bash
docker compose up --build        # CPU-only, works everywhere

# With NVIDIA GPU:
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
```

### GPU acceleration
- **NVIDIA (Linux)**: Use the `docker-compose.gpu.yml` override above. Requires `nvidia-container-toolkit` on the host.
- **Apple Silicon (M1/M2/M3)**: MPS acceleration is not available inside Docker (macOS doesn't pass GPU to containers). Run the backend natively (outside Docker) to use MPS — `get_device()` will auto-detect it.
- Verify device at runtime: `curl localhost:5000/api/health` → check `"device"` field.

## Key conventions

- Frontend is a single-file SPA (`App.tsx`). Components are defined as functions within that file, not split into separate files.
- Backend progress text from demucs is parsed/formatted by `format_progress()` before reaching the frontend — keep user-facing output clean and simple (no raw tqdm output).
- Master gain uses `1/sqrt(n)` scaling (not `1/n`) to balance clipping prevention with audible volume.
- Track reordering uses HTML5 drag-and-drop on `.channel-strip`. Interactive elements inside (sliders, buttons) must `stopPropagation` on `onPointerDown`, `onMouseDown`, and `onDragStart` to avoid triggering drag.
- Audio elements should use `canplaythrough` (not `loadeddata`) before considering tracks ready for playback.
- `play()` calls return promises that must be awaited/caught — never fire-and-forget.
- Seeking must wait for `seeked` events on all tracks before resuming playback.
- GPU acceleration: `get_device()` in `app.py` auto-detects the best available device. Torch is imported lazily inside this function to avoid requiring it at module load time (important for tests). The device is passed to Demucs via `-d`. The Dockerfile uses a `TORCH_VARIANT` build arg (default `cpu`); the GPU compose override sets it to `cu121`. MPS (Apple Silicon) only works when running natively outside Docker.
- Do NOT drift-correct tracks by reassigning `currentTime` in the animation frame loop — each assignment forces a browser seek that causes audible choppy/jagged playback. Sync tracks only at play and seek time; minor drift between independent `HTMLAudioElement`s is inaudible.
- DB schema migrations use `ALTER TABLE ... ADD COLUMN` wrapped in try/except for idempotency (SQLite lacks `IF NOT EXISTS` on ALTER TABLE).
- Mixer auto-save skips the initial render (via a ref flag) to avoid overwriting restored settings with defaults.
- When loading a job from the library, the `<Mixer>` component uses `key={jobId}` to force a full remount and clean audio teardown/setup.
