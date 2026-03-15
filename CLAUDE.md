# CLAUDE.md

## Project overview

Track Splitter — a web app that splits audio files into individual instrument tracks using Meta's Demucs model. Flask backend, React/TypeScript frontend, deployable via Docker.

## Architecture

- `backend/app.py` — Flask API: file upload, job queue, Demucs subprocess runner, SSE progress streaming, track serving. `get_device()` auto-detects GPU (CUDA → MPS → CPU fallback) for Demucs inference.
- `backend/demucs_wrapper.py` — Demucs subprocess helper; patches `torchaudio.save` to fall back to soundfile when torchcodec is unavailable.
- `frontend/src/App.tsx` — Single-file React SPA: upload flow, mixer/player UI with Web Audio API, drag-to-reorder tracks
- `frontend/src/types.ts` — Shared TypeScript interfaces

Progress flows from demucs stderr → `format_progress()` in app.py → SSE → frontend `ProgressDisplay` component.

Audio playback uses Web Audio API: each track is an `HTMLAudioElement` → `MediaElementAudioSourceNode` → per-track `GainNode` → master `GainNode` → destination.

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
docker compose up --build        # full stack on :5000
```

## Key conventions

- Frontend is a single-file SPA (`App.tsx`). Components are defined as functions within that file, not split into separate files.
- Backend progress text from demucs is parsed/formatted by `format_progress()` before reaching the frontend — keep user-facing output clean and simple (no raw tqdm output).
- Master gain uses `1/sqrt(n)` scaling (not `1/n`) to balance clipping prevention with audible volume.
- Track reordering uses HTML5 drag-and-drop on `.channel-strip`. Interactive elements inside (sliders, buttons) must `stopPropagation` on `onPointerDown`, `onMouseDown`, and `onDragStart` to avoid triggering drag.
- Audio elements should use `canplaythrough` (not `loadeddata`) before considering tracks ready for playback.
- `play()` calls return promises that must be awaited/caught — never fire-and-forget.
- Seeking must wait for `seeked` events on all tracks before resuming playback.
- GPU acceleration: `get_device()` in `app.py` auto-detects the best available device. Torch is imported lazily inside this function to avoid requiring it at module load time (important for tests). The device is passed to Demucs via `-d`.
