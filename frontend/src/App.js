import React, { useState, useRef, useCallback } from "react";
import "./App.css";

const API = process.env.REACT_APP_API_URL || "";

const MODELS = [
  { id: "htdemucs", label: "HTDemucs (4 stems)", desc: "Vocals, drums, bass, other" },
  { id: "htdemucs_6s", label: "HTDemucs 6-stem", desc: "Vocals, drums, bass, guitar, piano, other" },
];

const TRACK_ICONS = {
  vocals: "\u{1F3A4}",
  drums: "\u{1F941}",
  bass: "\u{1F3B8}",
  guitar: "\u{1F3B8}",
  piano: "\u{1F3B9}",
  other: "\u{1F3B6}",
};

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function UploadZone({ onFileSelected, disabled }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      if (disabled) return;
      const file = e.dataTransfer.files[0];
      if (file) onFileSelected(file);
    },
    [disabled, onFileSelected]
  );

  return (
    <div
      className={`upload-zone ${dragOver ? "drag-over" : ""} ${disabled ? "disabled" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
    >
      <div className="upload-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </div>
      <p className="upload-text">Drop a music file here or click to browse</p>
      <p className="upload-hint">MP3, WAV, FLAC, OGG, M4A, AAC &bull; Max 200 MB</p>
      <input
        ref={inputRef}
        type="file"
        accept=".mp3,.wav,.flac,.ogg,.m4a,.aac,.wma,.webm,audio/*"
        style={{ display: "none" }}
        onChange={(e) => e.target.files[0] && onFileSelected(e.target.files[0])}
      />
    </div>
  );
}

function TrackPlayer({ track, jobId }) {
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const audioRef = useRef(null);

  const src = `${API}/api/tracks/${jobId}/${track.filename}`;
  const icon = TRACK_ICONS[track.name.toLowerCase()] || "\u{1F3B5}";

  const toggle = () => {
    if (!audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setPlaying(!playing);
  };

  return (
    <div className={`track-card ${playing ? "playing" : ""}`}>
      <div className="track-icon">{icon}</div>
      <div className="track-info">
        <span className="track-name">{track.name}</span>
        <audio
          ref={audioRef}
          src={src}
          muted={muted}
          onEnded={() => setPlaying(false)}
          preload="none"
        />
      </div>
      <div className="track-controls">
        <button className="btn-icon" onClick={toggle} title={playing ? "Pause" : "Play"}>
          {playing ? "\u23F8" : "\u25B6"}
        </button>
        <button
          className={`btn-icon ${muted ? "muted" : ""}`}
          onClick={() => setMuted(!muted)}
          title={muted ? "Unmute" : "Mute"}
        >
          {muted ? "\u{1F507}" : "\u{1F50A}"}
        </button>
        <a href={src} download={track.filename} className="btn-icon" title="Download">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </a>
      </div>
    </div>
  );
}

export default function App() {
  const [file, setFile] = useState(null);
  const [model, setModel] = useState("htdemucs");
  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | uploading | processing | done | error
  const [tracks, setTracks] = useState([]);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState("");

  const reset = () => {
    setFile(null);
    setJobId(null);
    setStatus("idle");
    setTracks([]);
    setError(null);
    setProgress("");
  };

  const handleFileSelected = (f) => {
    setFile(f);
    setError(null);
  };

  const handleSplit = async () => {
    if (!file) return;

    try {
      // Upload
      setStatus("uploading");
      setProgress("Uploading file...");
      const formData = new FormData();
      formData.append("file", file);

      const uploadRes = await fetch(`${API}/api/upload`, { method: "POST", body: formData });
      if (!uploadRes.ok) {
        const err = await uploadRes.json();
        throw new Error(err.error || "Upload failed");
      }
      const { jobId: id } = await uploadRes.json();
      setJobId(id);

      // Split
      setStatus("processing");
      setProgress("Separating tracks... This may take a few minutes.");

      const splitRes = await fetch(`${API}/api/split/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });

      if (!splitRes.ok) {
        const err = await splitRes.json();
        throw new Error(err.error || "Splitting failed");
      }

      const data = await splitRes.json();
      setTracks(data.tracks);
      setStatus("done");
      setProgress("");
    } catch (err) {
      setStatus("error");
      setError(err.message);
      setProgress("");
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Track Splitter</h1>
        <p className="subtitle">
          Upload a song and split it into individual instrument tracks using AI
        </p>
      </header>

      <main className="main">
        {status === "done" ? (
          <div className="results">
            <div className="results-header">
              <h2>Separated Tracks</h2>
              <p className="results-filename">{file?.name}</p>
            </div>

            <div className="tracks-grid">
              {tracks.map((t) => (
                <TrackPlayer key={t.name} track={t} jobId={jobId} />
              ))}
            </div>

            <div className="results-actions">
              <a
                href={`${API}/api/tracks/${jobId}/download-all`}
                className="btn btn-primary"
                download
              >
                Download All Tracks (ZIP)
              </a>
              <button className="btn btn-secondary" onClick={reset}>
                Split Another Song
              </button>
            </div>
          </div>
        ) : (
          <div className="upload-section">
            <UploadZone
              onFileSelected={handleFileSelected}
              disabled={status === "uploading" || status === "processing"}
            />

            {file && status === "idle" && (
              <div className="file-info">
                <span className="file-name">{file.name}</span>
                <span className="file-size">{formatBytes(file.size)}</span>
              </div>
            )}

            {(status === "idle" && file) && (
              <div className="options">
                <label className="model-label">Separation model:</label>
                <div className="model-select">
                  {MODELS.map((m) => (
                    <button
                      key={m.id}
                      className={`model-option ${model === m.id ? "active" : ""}`}
                      onClick={() => setModel(m.id)}
                    >
                      <strong>{m.label}</strong>
                      <span>{m.desc}</span>
                    </button>
                  ))}
                </div>
                <button className="btn btn-primary btn-split" onClick={handleSplit}>
                  Split Track
                </button>
              </div>
            )}

            {(status === "uploading" || status === "processing") && (
              <div className="processing">
                <div className="spinner" />
                <p>{progress}</p>
              </div>
            )}

            {status === "error" && (
              <div className="error-box">
                <p>{error}</p>
                <button className="btn btn-secondary" onClick={reset}>
                  Try Again
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="footer">
        Powered by <a href="https://github.com/facebookresearch/demucs" target="_blank" rel="noreferrer">Demucs</a> by Meta Research
      </footer>
    </div>
  );
}
