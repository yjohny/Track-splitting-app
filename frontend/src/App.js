import React, { useState, useRef, useCallback, useEffect } from "react";
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

const TRACK_COLORS = {
  vocals: "#f472b6",
  drums: "#fb923c",
  bass: "#a78bfa",
  guitar: "#34d399",
  piano: "#60a5fa",
  other: "#fbbf24",
};

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatTime(sec) {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
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

/* ---- Mixer Channel Strip ---- */
function ChannelStrip({ track, volume, muted, solo, anySolo, onVolumeChange, onMuteToggle, onSoloToggle, jobId }) {
  const icon = TRACK_ICONS[track.name.toLowerCase()] || "\u{1F3B5}";
  const color = TRACK_COLORS[track.name.toLowerCase()] || "#888";
  const isAudible = !muted && (!anySolo || solo);
  const src = `${API}/api/tracks/${jobId}/${track.filename}`;

  return (
    <div className={`channel-strip ${!isAudible ? "silenced" : ""}`}>
      <div className="channel-header">
        <span className="channel-icon">{icon}</span>
        <span className="channel-name">{track.name}</span>
      </div>

      <div className="channel-slider-wrap">
        <input
          type="range"
          className="channel-slider"
          min="0"
          max="1"
          step="0.01"
          value={muted ? 0 : volume}
          onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
          style={{ "--track-color": color }}
        />
        <span className="channel-db">{muted ? "-\u221E" : volume === 0 ? "-\u221E" : `${Math.round(20 * Math.log10(volume))} dB`}</span>
      </div>

      <div className="channel-buttons">
        <button
          className={`ch-btn ch-mute ${muted ? "active" : ""}`}
          onClick={onMuteToggle}
          title={muted ? "Unmute" : "Mute"}
        >
          M
        </button>
        <button
          className={`ch-btn ch-solo ${solo ? "active" : ""}`}
          onClick={onSoloToggle}
          title={solo ? "Unsolo" : "Solo"}
        >
          S
        </button>
        <a href={src} download={track.filename} className="ch-btn ch-download" title="Download track">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </a>
      </div>
    </div>
  );
}

/* ---- Mixer component ---- */
function Mixer({ tracks, jobId, fileName }) {
  const audioCtxRef = useRef(null);
  const gainNodesRef = useRef({});
  const audioElementsRef = useRef({});
  const sourceNodesRef = useRef({});

  const [volumes, setVolumes] = useState({});
  const [mutes, setMutes] = useState({});
  const [solos, setSolos] = useState({});
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [mixingDown, setMixingDown] = useState(false);
  const animFrameRef = useRef(null);

  const anySolo = Object.values(solos).some(Boolean);

  // Initialize volumes
  useEffect(() => {
    const v = {}, m = {}, s = {};
    tracks.forEach((t) => {
      v[t.name] = 1;
      m[t.name] = false;
      s[t.name] = false;
    });
    setVolumes(v);
    setMutes(m);
    setSolos(s);
  }, [tracks]);

  // Initialize Web Audio API
  useEffect(() => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = ctx;

    const elements = {};
    const sources = {};
    const gains = {};
    let loadedCount = 0;
    let hasFinalized = false;

    const finalize = () => {
      if (hasFinalized) return;
      hasFinalized = true;
      const maxDur = Math.max(...tracks.map((tr) => {
        const el = elements[tr.name];
        return el && isFinite(el.duration) ? el.duration : 0;
      }));
      setDuration(maxDur);
      setLoaded(true);
    };

    const onTrackReady = () => {
      loadedCount++;
      if (loadedCount === tracks.length) finalize();
    };

    // Fallback timeout — if tracks haven't loaded after 30s, force-show the mixer
    const timeout = setTimeout(() => {
      if (!hasFinalized) {
        console.warn("Audio loading timed out — showing mixer with available tracks");
        finalize();
      }
    }, 30000);

    tracks.forEach((t) => {
      const audio = new Audio(`${API}/api/tracks/${jobId}/${t.filename}`);
      audio.crossOrigin = "anonymous";
      audio.preload = "auto";

      // Use loadeddata (fires earlier, more reliable) with canplaythrough as bonus
      audio.addEventListener("loadeddata", onTrackReady, { once: true });

      audio.addEventListener("error", () => {
        console.error(`Failed to load track: ${t.name}`, audio.error);
        onTrackReady(); // Count it so we don't block forever
      }, { once: true });

      const source = ctx.createMediaElementSource(audio);
      const gain = ctx.createGain();
      source.connect(gain);
      gain.connect(ctx.destination);

      elements[t.name] = audio;
      sources[t.name] = source;
      gains[t.name] = gain;
    });

    audioElementsRef.current = elements;
    sourceNodesRef.current = sources;
    gainNodesRef.current = gains;

    return () => {
      clearTimeout(timeout);
      Object.values(elements).forEach((a) => { a.pause(); a.src = ""; });
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      ctx.close();
    };
  }, [tracks, jobId]);

  // Sync gain values
  useEffect(() => {
    tracks.forEach((t) => {
      const gain = gainNodesRef.current[t.name];
      if (!gain) return;
      const isMuted = mutes[t.name];
      const isSolo = solos[t.name];
      const audible = !isMuted && (!anySolo || isSolo);
      gain.gain.value = audible ? (volumes[t.name] ?? 1) : 0;
    });
  }, [volumes, mutes, solos, anySolo, tracks]);

  // Animation frame for time
  useEffect(() => {
    const tick = () => {
      const first = Object.values(audioElementsRef.current)[0];
      if (first) setCurrentTime(first.currentTime);
      animFrameRef.current = requestAnimationFrame(tick);
    };
    if (playing) {
      animFrameRef.current = requestAnimationFrame(tick);
    } else {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    }
    return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
  }, [playing]);

  // Listen for ended
  useEffect(() => {
    const first = Object.values(audioElementsRef.current)[0];
    if (!first) return;
    const onEnded = () => { setPlaying(false); setCurrentTime(0); };
    first.addEventListener("ended", onEnded);
    return () => first.removeEventListener("ended", onEnded);
  }, [loaded]);

  const playAll = async () => {
    if (audioCtxRef.current?.state === "suspended") {
      await audioCtxRef.current.resume();
    }
    Object.values(audioElementsRef.current).forEach((a) => a.play());
    setPlaying(true);
  };

  const pauseAll = () => {
    Object.values(audioElementsRef.current).forEach((a) => a.pause());
    setPlaying(false);
  };

  const stopAll = () => {
    Object.values(audioElementsRef.current).forEach((a) => {
      a.pause();
      a.currentTime = 0;
    });
    setPlaying(false);
    setCurrentTime(0);
  };

  const seek = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = ratio * duration;
    Object.values(audioElementsRef.current).forEach((a) => { a.currentTime = time; });
    setCurrentTime(time);
  };

  const handleDownloadMix = async () => {
    setMixingDown(true);
    try {
      // Build volume map from current mixer state
      const volumeMap = {};
      tracks.forEach((t) => {
        const isMuted = mutes[t.name];
        const isSolo = solos[t.name];
        const audible = !isMuted && (!anySolo || isSolo);
        volumeMap[t.name] = audible ? (volumes[t.name] ?? 1) : 0;
      });

      const res = await fetch(`${API}/api/tracks/${jobId}/mix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ volumes: volumeMap }),
      });

      if (!res.ok) throw new Error("Mix failed");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${fileName.replace(/\.[^.]+$/, "")}_custom_mix.wav`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Failed to download mix: " + err.message);
    }
    setMixingDown(false);
  };

  return (
    <div className="mixer">
      {/* Transport bar */}
      <div className="transport">
        <div className="transport-buttons">
          <button className="transport-btn" onClick={stopAll} title="Stop" disabled={!loaded}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
          </button>
          <button className="transport-btn play-btn" onClick={playing ? pauseAll : playAll} title={playing ? "Pause" : "Play"} disabled={!loaded}>
            {playing ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20" /></svg>
            )}
          </button>
        </div>

        <span className="transport-time">{formatTime(currentTime)}</span>

        <div className="transport-progress" onClick={loaded ? seek : undefined}>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: duration ? `${(currentTime / duration) * 100}%` : "0%" }}
            />
          </div>
        </div>

        <span className="transport-time">{formatTime(duration)}</span>
      </div>

      {!loaded && (
        <div className="mixer-loading">
          <div className="spinner" />
          <span>Loading tracks...</span>
        </div>
      )}

      {/* Channel strips */}
      <div className="channel-strips">
        {tracks.map((t) => (
          <ChannelStrip
            key={t.name}
            track={t}
            jobId={jobId}
            volume={volumes[t.name] ?? 1}
            muted={mutes[t.name] ?? false}
            solo={solos[t.name] ?? false}
            anySolo={anySolo}
            onVolumeChange={(v) => setVolumes((prev) => ({ ...prev, [t.name]: v }))}
            onMuteToggle={() => setMutes((prev) => ({ ...prev, [t.name]: !prev[t.name] }))}
            onSoloToggle={() => setSolos((prev) => ({ ...prev, [t.name]: !prev[t.name] }))}
          />
        ))}
      </div>

      {/* Download actions */}
      <div className="download-section">
        <h3 className="download-title">Download</h3>
        <div className="download-buttons">
          <a
            href={`${API}/api/tracks/${jobId}/download-all`}
            className="btn btn-primary"
            download
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            All Tracks (ZIP)
          </a>
          <button
            className="btn btn-accent"
            onClick={handleDownloadMix}
            disabled={mixingDown}
          >
            {mixingDown ? (
              <>
                <div className="spinner-small" />
                Mixing...
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
                Download Current Mix
              </>
            )}
          </button>
        </div>
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
              <div>
                <h2>Separated Tracks</h2>
                <p className="results-filename">{file?.name}</p>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={reset}>
                Split Another Song
              </button>
            </div>

            <Mixer tracks={tracks} jobId={jobId} fileName={file?.name || "track"} />
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
