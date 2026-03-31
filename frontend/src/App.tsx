import React, { useState, useRef, useCallback, useEffect } from "react";
import "./App.css";
import { Track, Model, AppStatus, ExportFormat, Theme, ProgressEvent, MixerSettings, LibraryJob } from "./types";

const API = process.env.REACT_APP_API_URL || "";

const MODELS: Model[] = [
  { id: "htdemucs", label: "HTDemucs (4 stems)", desc: "Vocals, drums, bass, other" },
  { id: "htdemucs_6s", label: "HTDemucs 6-stem", desc: "Vocals, drums, bass, guitar, piano, other" },
];

const TRACK_ICONS: Record<string, string> = {
  vocals: "\u{1F3A4}",
  drums: "\u{1F941}",
  bass: "\u{1F3B8}",
  guitar: "\u{1F3B8}",
  piano: "\u{1F3B9}",
  other: "\u{1F3B6}",
};

const TRACK_COLORS: Record<string, string> = {
  vocals: "#f472b6",
  drums: "#fb923c",
  bass: "#a78bfa",
  guitar: "#34d399",
  piano: "#60a5fa",
  other: "#fbbf24",
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatTime(sec: number): string {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/* ---- Theme Hook ---- */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("theme") as Theme | null;
    return saved || "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  return [theme, toggleTheme];
}

/* ---- Upload Zone ---- */
interface UploadZoneProps {
  onFileSelected: (file: File) => void;
  disabled: boolean;
}

function UploadZone({ onFileSelected, disabled }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
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
      role="button"
      tabIndex={0}
      aria-label="Upload audio file"
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); !disabled && inputRef.current?.click(); } }}
    >
      <div className="upload-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
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
        onChange={(e) => e.target.files?.[0] && onFileSelected(e.target.files[0])}
        aria-hidden="true"
      />
    </div>
  );
}

/* ---- Waveform Component ---- */
interface WaveformProps {
  audioUrl: string;
  color: string;
  height?: number;
}

// Shared AudioContext for waveform decoding — avoids creating one per track,
// which can exhaust the browser's AudioContext limit and break the Mixer's context.
let _waveformCtx: AudioContext | null = null;
function getWaveformContext(): AudioContext {
  if (!_waveformCtx || _waveformCtx.state === "closed") {
    _waveformCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return _waveformCtx;
}

const Waveform = React.memo(function Waveform({ audioUrl, color, height = 40 }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [waveformData, setWaveformData] = useState<number[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ctx = getWaveformContext();

    fetch(audioUrl)
      .then((res) => res.arrayBuffer())
      .then((buf) => ctx.decodeAudioData(buf))
      .then((audioBuffer) => {
        if (cancelled) return;
        const rawData = audioBuffer.getChannelData(0);
        const samples = 100;
        const blockSize = Math.floor(rawData.length / samples);
        const peaks: number[] = [];
        for (let i = 0; i < samples; i++) {
          let sum = 0;
          for (let j = 0; j < blockSize; j++) {
            sum += Math.abs(rawData[i * blockSize + j]);
          }
          peaks.push(sum / blockSize);
        }
        const max = Math.max(...peaks);
        setWaveformData(peaks.map((p) => (max > 0 ? p / max : 0)));
      })
      .catch(() => {
        // Silently fail - waveform is optional
      });

    return () => { cancelled = true; };
  }, [audioUrl]);

  useEffect(() => {
    if (!waveformData || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const width = canvas.offsetWidth;
    const barWidth = width / waveformData.length;
    const halfHeight = height / 2;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.6;

    waveformData.forEach((val, i) => {
      const barHeight = val * halfHeight * 0.9;
      const x = i * barWidth;
      ctx.fillRect(x, halfHeight - barHeight, barWidth - 1, barHeight * 2);
    });
  }, [waveformData, color, height]);

  if (!waveformData) return null;

  return (
    <canvas
      ref={canvasRef}
      className="waveform-canvas"
      style={{ width: "100%", height: `${height}px` }}
      aria-hidden="true"
    />
  );
});

/* ---- Channel Strip ---- */
interface ChannelStripProps {
  track: Track;
  volume: number;
  muted: boolean;
  solo: boolean;
  anySolo: boolean;
  onVolumeChange: (name: string, v: number) => void;
  onMuteToggle: (name: string) => void;
  onSoloToggle: (name: string) => void;
  jobId: string;
  exportFormat: ExportFormat;
  index: number;
  onDragStart: (index: number) => void;
  onDragOver: (index: number) => void;
  onDragEnd: () => void;
  isDragTarget: boolean;
}

const ChannelStrip = React.memo(function ChannelStrip({
  track, volume, muted, solo, anySolo,
  onVolumeChange, onMuteToggle, onSoloToggle,
  jobId, exportFormat, index,
  onDragStart, onDragOver, onDragEnd, isDragTarget,
}: ChannelStripProps) {
  // Safari sets e.target to the draggable element itself in dragstart,
  // so we can't use closest() to detect the child. Track it via pointer events instead.
  const pointerOnInteractive = useRef(false);

  const icon = TRACK_ICONS[track.name.toLowerCase()] || "\u{1F3B5}";
  const color = TRACK_COLORS[track.name.toLowerCase()] || "#888";
  const isAudible = !muted && (!anySolo || solo);
  const formatParam = exportFormat !== "wav" ? `?format=${exportFormat}` : "";
  const src = `${API}/api/tracks/${jobId}/${track.filename}${formatParam}`;
  const audioUrl = `${API}/api/tracks/${jobId}/${track.filename}`;

  return (
    <div
      className={`channel-strip ${!isAudible ? "silenced" : ""} ${isDragTarget ? "drag-target" : ""}`}
      draggable
      onPointerDown={(e) => {
        const target = e.target as HTMLElement;
        pointerOnInteractive.current = !!(target.closest(".channel-slider-wrap") || target.closest(".channel-buttons"));
      }}
      onDragStart={(e) => {
        if (pointerOnInteractive.current) {
          e.preventDefault();
          return;
        }
        onDragStart(index);
      }}
      onDragOver={(e) => { e.preventDefault(); onDragOver(index); }}
      onDragEnd={onDragEnd}
      role="listitem"
      aria-label={`${track.name} track`}
    >
      <div className="channel-header">
        <span className="drag-handle" aria-hidden="true">&#x2630;</span>
        <span className="channel-icon" aria-hidden="true">{icon}</span>
        <span className="channel-name">{track.name}</span>
      </div>

      <div className="channel-body">
        <Waveform audioUrl={audioUrl} color={color} />
        <div className="channel-slider-wrap">
          <input
            type="range"
            className="channel-slider"
            min="0"
            max="1"
            step="0.01"
            value={muted ? 0 : volume}
            onChange={(e) => onVolumeChange(track.name, parseFloat(e.target.value))}
            style={{ "--track-color": color } as React.CSSProperties}
            aria-label={`${track.name} volume`}
          />
          <span className="channel-db">
            {muted ? "-\u221E" : volume === 0 ? "-\u221E" : `${Math.round(20 * Math.log10(volume))} dB`}
          </span>
        </div>
      </div>

      <div className="channel-buttons">
        <button
          className={`ch-btn ch-mute ${muted ? "active" : ""}`}
          onClick={() => onMuteToggle(track.name)}
          title={muted ? "Unmute" : "Mute"}
          aria-label={muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
          aria-pressed={muted}
        >
          M
        </button>
        <button
          className={`ch-btn ch-solo ${solo ? "active" : ""}`}
          onClick={() => onSoloToggle(track.name)}
          title={solo ? "Unsolo" : "Solo"}
          aria-label={solo ? `Unsolo ${track.name}` : `Solo ${track.name}`}
          aria-pressed={solo}
        >
          S
        </button>
        <a href={src} download={track.filename} className="ch-btn ch-download" title="Download track" aria-label={`Download ${track.name}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </a>
      </div>
    </div>
  );
});

/* ---- Mixer component ---- */
interface MixerProps {
  tracks: Track[];
  jobId: string;
  fileName: string;
  initialSettings?: MixerSettings | null;
  onNameChange?: (name: string) => void;
  jobName?: string | null;
}

function Mixer({ tracks: initialTracks, jobId, fileName, initialSettings, onNameChange, jobName }: MixerProps) {
  const audioElementsRef = useRef<Record<string, HTMLAudioElement>>({});

  const [trackOrder, setTrackOrder] = useState<Track[]>(initialTracks);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [mutes, setMutes] = useState<Record<string, boolean>>({});
  const [solos, setSolos] = useState<Record<string, boolean>>({});
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [mixingDown, setMixingDown] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("wav");
  const [selectedTrack, setSelectedTrack] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragTarget, setDragTarget] = useState<number | null>(null);
  const [mixError, setMixError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState(jobName || "");
  const [transposition, setTransposition] = useState<number>(initialSettings?.transposition ?? 0);
  const animFrameRef = useRef<number | null>(null);

  const anySolo = Object.values(solos).some(Boolean);

  // Initialize volumes (restore from saved settings if available)
  useEffect(() => {
    const v: Record<string, number> = {};
    const m: Record<string, boolean> = {};
    const s: Record<string, boolean> = {};
    initialTracks.forEach((t) => {
      v[t.name] = initialSettings?.volumes?.[t.name] ?? 1;
      m[t.name] = initialSettings?.mutes?.[t.name] ?? false;
      s[t.name] = initialSettings?.solos?.[t.name] ?? false;
    });
    setVolumes(v);
    setMutes(m);
    setSolos(s);
    // Restore track order if saved
    if (initialSettings?.trackOrder?.length) {
      const ordered: Track[] = [];
      for (const name of initialSettings.trackOrder) {
        const found = initialTracks.find((t) => t.name === name);
        if (found) ordered.push(found);
      }
      // Add any tracks not in saved order (e.g. new tracks)
      for (const t of initialTracks) {
        if (!ordered.find((o) => o.name === t.name)) ordered.push(t);
      }
      setTrackOrder(ordered);
    } else {
      setTrackOrder(initialTracks);
    }
  }, [initialTracks, initialSettings]);

  // Build track URL with optional transposition query param
  const trackUrl = useCallback((filename: string) => {
    const params = transposition !== 0 ? `?semitones=${transposition}` : "";
    return `${API}/api/tracks/${jobId}/${filename}${params}`;
  }, [jobId, transposition]);

  // Load audio elements (no Web Audio API — use native volume for Safari compat)
  // Re-runs when transposition changes to reload pitch-shifted audio.
  useEffect(() => {
    const elements: Record<string, HTMLAudioElement> = {};
    let loadedCount = 0;
    let hasFinalized = false;
    setLoaded(false);

    // Capture the playback position so we can restore it after reload
    const prevElements = audioElementsRef.current;
    const prevTime = Object.values(prevElements)[0]?.currentTime ?? 0;
    // Tear down previous audio elements
    Object.values(prevElements).forEach((a) => { a.pause(); a.src = ""; });
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

    const finalize = () => {
      if (hasFinalized) return;
      hasFinalized = true;
      const maxDur = Math.max(...initialTracks.map((tr) => {
        const el = elements[tr.name];
        return el && isFinite(el.duration) ? el.duration : 0;
      }));
      setDuration(maxDur);
      // Restore previous playback position
      if (prevTime > 0) {
        Object.values(elements).forEach((a) => { a.currentTime = prevTime; });
        setCurrentTime(prevTime);
      }
      setLoaded(true);
    };

    const onTrackReady = () => {
      loadedCount++;
      if (loadedCount === initialTracks.length) finalize();
    };

    const timeout = setTimeout(() => {
      if (!hasFinalized) {
        console.warn("Audio loading timed out — showing mixer with available tracks");
        finalize();
      }
    }, 30000);

    initialTracks.forEach((t) => {
      const audio = new Audio();
      audio.preload = "auto";
      audio.src = trackUrl(t.filename);

      audio.addEventListener("canplaythrough", onTrackReady, { once: true });
      audio.addEventListener("error", () => {
        console.error(`Failed to load track: ${t.name}`, audio.error);
        onTrackReady();
      }, { once: true });

      audio.load();
      elements[t.name] = audio;
    });

    audioElementsRef.current = elements;

    return () => {
      clearTimeout(timeout);
      Object.values(elements).forEach((a) => { a.pause(); a.src = ""; });
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [initialTracks, jobId, trackUrl]);

  // Sync volume via native HTMLAudioElement.volume (Safari-compatible)
  useEffect(() => {
    let audibleCount = 0;
    initialTracks.forEach((t) => {
      const isMuted = mutes[t.name];
      const isSolo = solos[t.name];
      const audible = !isMuted && (!anySolo || isSolo);
      if (audible && (volumes[t.name] ?? 1) > 0) audibleCount++;
    });
    const masterScale = 1 / Math.max(1, Math.sqrt(audibleCount));

    initialTracks.forEach((t) => {
      const audio = audioElementsRef.current[t.name];
      if (!audio) return;
      const isMuted = mutes[t.name];
      const isSolo = solos[t.name];
      const audible = !isMuted && (!anySolo || isSolo);
      audio.volume = audible ? (volumes[t.name] ?? 1) * masterScale : 0;
    });
  }, [volumes, mutes, solos, anySolo, initialTracks]);

  // Animation frame for time display only — no drift correction during playback.
  // Setting currentTime on HTMLAudioElements causes audible micro-seeks/glitches.
  // Tracks are synced at play and seek time; minor drift is inaudible.
  useEffect(() => {
    const tick = () => {
      const first = Object.values(audioElementsRef.current)[0];
      if (first) {
        setCurrentTime(first.currentTime);
      }
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

  // Auto-save mixer settings (debounced)
  const settingsInitialized = useRef(false);
  useEffect(() => {
    // Skip the initial render to avoid saving defaults over saved settings
    if (!settingsInitialized.current) {
      settingsInitialized.current = true;
      return;
    }
    const timer = setTimeout(() => {
      const settings = {
        volumes,
        mutes,
        solos,
        trackOrder: trackOrder.map((t) => t.name),
        transposition,
      };
      fetch(`${API}/api/jobs/${jobId}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      }).catch(() => {});
    }, 1000);
    return () => clearTimeout(timer);
  }, [volumes, mutes, solos, trackOrder, transposition, jobId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Don't handle if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          if (playing) pauseAll();
          else playAll();
          break;
        case "m":
        case "M":
          if (trackOrder[selectedTrack]) {
            const name = trackOrder[selectedTrack].name;
            setMutes((prev) => ({ ...prev, [name]: !prev[name] }));
          }
          break;
        case "s":
        case "S":
          if (trackOrder[selectedTrack]) {
            const name = trackOrder[selectedTrack].name;
            setSolos((prev) => ({ ...prev, [name]: !prev[name] }));
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) {
            // Ctrl+Up: move track up
            if (selectedTrack > 0) {
              setTrackOrder((prev) => {
                const newOrder = [...prev];
                [newOrder[selectedTrack - 1], newOrder[selectedTrack]] = [newOrder[selectedTrack], newOrder[selectedTrack - 1]];
                return newOrder;
              });
              setSelectedTrack((prev) => prev - 1);
            }
          } else {
            setSelectedTrack((prev) => Math.max(0, prev - 1));
          }
          break;
        case "ArrowDown":
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) {
            // Ctrl+Down: move track down
            if (selectedTrack < trackOrder.length - 1) {
              setTrackOrder((prev) => {
                const newOrder = [...prev];
                [newOrder[selectedTrack], newOrder[selectedTrack + 1]] = [newOrder[selectedTrack + 1], newOrder[selectedTrack]];
                return newOrder;
              });
              setSelectedTrack((prev) => prev + 1);
            }
          } else {
            setSelectedTrack((prev) => Math.min(trackOrder.length - 1, prev + 1));
          }
          break;
        case "ArrowLeft":
          if (trackOrder[selectedTrack]) {
            const name = trackOrder[selectedTrack].name;
            setVolumes((prev) => ({ ...prev, [name]: Math.max(0, (prev[name] ?? 1) - 0.05) }));
          }
          break;
        case "ArrowRight":
          if (trackOrder[selectedTrack]) {
            const name = trackOrder[selectedTrack].name;
            setVolumes((prev) => ({ ...prev, [name]: Math.min(1, (prev[name] ?? 1) + 0.05) }));
          }
          break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  const playAll = async () => {
    // Sync all tracks to the same currentTime before playing to avoid drift
    const els = Object.values(audioElementsRef.current);
    if (els.length > 0) {
      const syncTime = els[0].currentTime;
      els.forEach((a) => { a.currentTime = syncTime; });
    }
    // Collect all play promises and fire them as close together as possible
    await Promise.all(els.map((a) => a.play().catch((err) => {
      console.warn("Track play() failed, retrying:", err);
      return a.play().catch(() => {});
    })));
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

  const seek = async (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = ratio * duration;
    const els = Object.values(audioElementsRef.current);
    // Pause all before seeking to avoid desync from mid-playback seeks
    const wasPlaying = playing;
    els.forEach((a) => a.pause());
    // Wait for all tracks to finish seeking before resuming playback
    await Promise.all(els.map((a) => new Promise<void>((resolve) => {
      a.addEventListener("seeked", () => resolve(), { once: true });
      a.currentTime = time;
    })));
    if (wasPlaying) {
      await Promise.all(els.map((a) => a.play().catch(() => {})));
    }
    setCurrentTime(time);
  };

  const handleVolumeChange = useCallback((name: string, v: number) => {
    setVolumes((prev) => ({ ...prev, [name]: v }));
  }, []);

  const handleMuteToggle = useCallback((name: string) => {
    setMutes((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  const handleSoloToggle = useCallback((name: string) => {
    setSolos((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  // Drag-to-reorder handlers
  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  const handleDragOver = useCallback((index: number) => {
    setDragTarget(index);
  }, []);

  const handleDragEnd = useCallback(() => {
    if (dragIndex !== null && dragTarget !== null && dragIndex !== dragTarget) {
      setTrackOrder((prev) => {
        const newOrder = [...prev];
        const [moved] = newOrder.splice(dragIndex, 1);
        newOrder.splice(dragTarget, 0, moved);
        return newOrder;
      });
    }
    setDragIndex(null);
    setDragTarget(null);
  }, [dragIndex, dragTarget]);

  const handleDownloadMix = async () => {
    setMixingDown(true);
    setMixError(null);
    try {
      const volumeMap: Record<string, number> = {};
      initialTracks.forEach((t) => {
        const isMuted = mutes[t.name];
        const isSolo = solos[t.name];
        const audible = !isMuted && (!anySolo || isSolo);
        volumeMap[t.name] = audible ? (volumes[t.name] ?? 1) : 0;
      });

      const res = await fetch(`${API}/api/tracks/${jobId}/mix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ volumes: volumeMap, format: exportFormat, semitones: transposition }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Mix failed");
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ext = exportFormat === "wav" ? ".wav" : exportFormat === "mp3" ? ".mp3" : ".flac";
      a.download = `${fileName.replace(/\.[^.]+$/, "")}_custom_mix${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setMixError(err.message || "Failed to download mix");
    }
    setMixingDown(false);
  };

  const handleDownloadAll = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const url = (e.currentTarget as HTMLAnchorElement).href;
    setDownloading((prev) => ({ ...prev, all: true }));
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `${fileName.replace(/\.[^.]+$/, "")}_tracks.zip`;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch {
      setMixError("Failed to download tracks. Please try again.");
    }
    setDownloading((prev) => ({ ...prev, all: false }));
  };

  return (
    <div className="mixer" role="region" aria-label="Audio mixer">
      {/* Transport bar */}
      <div className="transport" role="toolbar" aria-label="Playback controls">
        <div className="transport-buttons">
          <button className="transport-btn" onClick={stopAll} title="Stop" disabled={!loaded} aria-label="Stop">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
          </button>
          <button className="transport-btn play-btn" onClick={playing ? pauseAll : playAll} title={playing ? "Pause" : "Play"} disabled={!loaded} aria-label={playing ? "Pause" : "Play"}>
            {playing ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6,4 20,12 6,20" /></svg>
            )}
          </button>
        </div>

        <span className="transport-time" aria-label="Current time">{formatTime(currentTime)}</span>

        <div className="transport-progress" onClick={loaded ? seek : undefined} role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={currentTime}>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: duration ? `${(currentTime / duration) * 100}%` : "0%" }} />
          </div>
        </div>

        <span className="transport-time" aria-label="Duration">{formatTime(duration)}</span>
      </div>

      {!loaded && (
        <div className="mixer-loading">
          <div className="spinner" />
          <span>Loading tracks...</span>
        </div>
      )}

      {/* Transposition control */}
      {loaded && (
        <div className="transposition-control" role="group" aria-label="Key transposition">
          <span className="transposition-label">Key</span>
          <button
            className="transposition-btn"
            onClick={() => setTransposition((p) => Math.max(-12, p - 1))}
            disabled={transposition <= -12}
            aria-label="Transpose down one semitone"
            title="Down one semitone"
          >
            &minus;
          </button>
          <span className="transposition-value" aria-live="polite">
            {transposition === 0 ? "Original" : `${transposition > 0 ? "+" : ""}${transposition} st`}
          </span>
          <button
            className="transposition-btn"
            onClick={() => setTransposition((p) => Math.min(12, p + 1))}
            disabled={transposition >= 12}
            aria-label="Transpose up one semitone"
            title="Up one semitone"
          >
            +
          </button>
          {transposition !== 0 && (
            <button
              className="transposition-reset"
              onClick={() => setTransposition(0)}
              aria-label="Reset transposition"
              title="Reset to original key"
            >
              Reset
            </button>
          )}
        </div>
      )}

      {/* Keyboard shortcut hint */}
      {loaded && (
        <div className="shortcut-hint" aria-hidden="true">
          <span>Space: Play/Pause</span>
          <span>M: Mute</span>
          <span>S: Solo</span>
          <span>Arrows: Navigate/Volume</span>
          <span>Ctrl+\u2191\u2193: Reorder</span>
        </div>
      )}

      {/* Channel strips */}
      <div className="channel-strips" role="list" aria-label="Track channels">
        {trackOrder.map((t, i) => (
          <ChannelStrip
            key={t.name}
            track={t}
            jobId={jobId}
            volume={volumes[t.name] ?? 1}
            muted={mutes[t.name] ?? false}
            solo={solos[t.name] ?? false}
            anySolo={anySolo}
            exportFormat={exportFormat}
            onVolumeChange={handleVolumeChange}
            onMuteToggle={handleMuteToggle}
            onSoloToggle={handleSoloToggle}
            index={i}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            isDragTarget={dragTarget === i}
          />
        ))}
      </div>

      {/* Export format selector */}
      <div className="export-format">
        <label className="export-label" id="export-format-label">Export format:</label>
        <div className="format-buttons" role="radiogroup" aria-labelledby="export-format-label">
          {(["wav", "mp3", "flac"] as ExportFormat[]).map((fmt) => (
            <button
              key={fmt}
              className={`format-btn ${exportFormat === fmt ? "active" : ""}`}
              onClick={() => setExportFormat(fmt)}
              role="radio"
              aria-checked={exportFormat === fmt}
            >
              {fmt.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Download error */}
      {mixError && (
        <div className="mixer-error" role="alert">
          <p>{mixError}</p>
          <button className="mixer-error-dismiss" onClick={() => setMixError(null)} aria-label="Dismiss error">&times;</button>
        </div>
      )}

      {/* Download actions */}
      <div className="download-section">
        <h3 className="download-title">Download</h3>
        <div className="download-buttons">
          <a
            href={`${API}/api/tracks/${jobId}/download-all${exportFormat !== "wav" ? `?format=${exportFormat}` : ""}`}
            className="btn btn-primary"
            onClick={handleDownloadAll}
            aria-label="Download all tracks as ZIP"
          >
            {downloading.all ? (
              <>
                <div className="spinner-small" />
                Downloading...
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                All Tracks (ZIP)
              </>
            )}
          </a>
          <button
            className="btn btn-accent"
            onClick={handleDownloadMix}
            disabled={mixingDown}
            aria-label="Download custom mix"
          >
            {mixingDown ? (
              <>
                <div className="spinner-small" />
                Mixing...
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
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

/* ---- Progress Display ---- */
interface ProgressDisplayProps {
  progress: string;
  status: AppStatus;
}

function ProgressDisplay({ progress, status }: ProgressDisplayProps) {
  return (
    <div className="processing" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <p className="progress-text">{progress}</p>
      {status === "queued" && (
        <p className="progress-subtext">Your file is in the processing queue. It will start automatically.</p>
      )}
      {status === "processing" && (
        <p className="progress-subtext">AI is separating your tracks. This usually takes 2-5 minutes.</p>
      )}
    </div>
  );
}

/* ---- Editable Name ---- */
interface EditableNameProps {
  name: string;
  onSave: (name: string) => void;
}

function EditableName({ name, onSave }: EditableNameProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  const save = () => {
    setEditing(false);
    if (value.trim() && value.trim() !== name) {
      onSave(value.trim());
    } else {
      setValue(name);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="editable-name-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { setValue(name); setEditing(false); } }}
        maxLength={200}
      />
    );
  }

  return (
    <p className="results-filename editable-name" onClick={() => { setValue(name); setEditing(true); }} title="Click to rename">
      {name}
      <svg className="edit-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    </p>
  );
}

/* ---- Library Component ---- */
interface LibraryProps {
  onSelectJob: (job: LibraryJob) => void;
  onNewSplit: () => void;
}

function Library({ onSelectJob, onNewSplit }: LibraryProps) {
  const [jobs, setJobs] = useState<LibraryJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/jobs`);
      if (res.ok) {
        setJobs(await res.json());
      }
    } catch {
      // silently fail
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const handleDelete = async (id: string) => {
    try {
      await fetch(`${API}/api/jobs/${id}`, { method: "DELETE" });
      setJobs((prev) => prev.filter((j) => j.id !== id));
    } catch {
      // silently fail
    }
    setDeleteConfirm(null);
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
      + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="library">
      <div className="library-header">
        <h2>Your Library</h2>
        <button className="btn btn-primary btn-sm" onClick={onNewSplit}>
          New Split
        </button>
      </div>

      {loading && (
        <div className="mixer-loading">
          <div className="spinner" />
          <span>Loading library...</span>
        </div>
      )}

      {!loading && jobs.length === 0 && (
        <div className="library-empty">
          <p>No saved splits yet.</p>
          <p className="library-empty-hint">Upload a song and split it to see it here.</p>
        </div>
      )}

      {!loading && jobs.length > 0 && (
        <div className="library-list">
          {jobs.map((job) => (
            <div key={job.id} className="library-item" onClick={() => onSelectJob(job)} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") onSelectJob(job); }}>
              <div className="library-item-info">
                <span className="library-item-name">{job.name || job.filename}</span>
                <span className="library-item-meta">
                  {job.trackCount} tracks &bull; {formatDate(job.createdAt)}
                </span>
              </div>
              <button
                className="ch-btn library-item-delete"
                onClick={(e) => { e.stopPropagation(); setDeleteConfirm(job.id); }}
                title="Delete"
                aria-label={`Delete ${job.name || job.filename}`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6" /><path d="M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>

              {deleteConfirm === job.id && (
                <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
                  <p>Delete this split?</p>
                  <div className="confirm-buttons">
                    <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); setDeleteConfirm(null); }}>Cancel</button>
                    <button className="btn btn-sm confirm-delete-btn" onClick={(e) => { e.stopPropagation(); handleDelete(job.id); }}>Delete</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- Main App ---- */
export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [model, setModel] = useState("htdemucs");
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<AppStatus>("idle");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [theme, toggleTheme] = useTheme();
  const [view, setView] = useState<"split" | "library">("split");
  const [displayName, setDisplayName] = useState<string>("");
  const [mixerSettings, setMixerSettings] = useState<MixerSettings | null>(null);
  const [jobName, setJobName] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);

  const reset = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setFile(null);
    setJobId(null);
    setStatus("idle");
    setTracks([]);
    setError(null);
    setProgress("");
    setMixerSettings(null);
    setJobName(null);
    setDisplayName("");
  };

  const handleFileSelected = (f: File) => {
    setFile(f);
    setError(null);
  };

  const loadFromLibrary = async (job: LibraryJob) => {
    try {
      const res = await fetch(`${API}/api/status/${job.id}`);
      if (!res.ok) throw new Error("Failed to load job");
      const data = await res.json();
      setJobId(data.id);
      setTracks(data.tracks || []);
      setStatus("done");
      setDisplayName(data.name || data.filename);
      setJobName(data.name || null);
      setMixerSettings(data.mixer_settings || null);
      setView("split");
    } catch {
      setError("Failed to load saved split");
    }
  };

  const handleRename = async (name: string) => {
    if (!jobId || !name.trim()) return;
    try {
      await fetch(`${API}/api/jobs/${jobId}/name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      setJobName(name.trim());
      setDisplayName(name.trim());
    } catch {
      // silently fail
    }
  };

  const startSSE = useCallback((id: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`${API}/api/progress/${id}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data: ProgressEvent = JSON.parse(event.data);
        if (data.progress) setProgress(data.progress);

        if (data.status === "done" && data.tracks) {
          setTracks(data.tracks);
          setStatus("done");
          setProgress("");
          es.close();
        } else if (data.status === "error") {
          setStatus("error");
          setError(data.error || "Processing failed");
          setProgress("");
          es.close();
        } else if (data.status === "processing") {
          setStatus("processing");
        }
      } catch {
        // Ignore parse errors
      }
    };

    es.onerror = () => {
      // SSE disconnected — fall back to polling
      es.close();
      pollStatus(id);
    };
  }, []);

  const pollStatus = useCallback(async (id: string) => {
    const poll = async () => {
      try {
        const res = await fetch(`${API}/api/status/${id}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === "done") {
          setTracks(data.tracks);
          setStatus("done");
          setProgress("");
          return;
        }
        if (data.status === "error") {
          setStatus("error");
          setError(data.error || "Processing failed");
          setProgress("");
          return;
        }
        if (data.progress) setProgress(data.progress);
        setTimeout(poll, 3000);
      } catch {
        setTimeout(poll, 5000);
      }
    };
    poll();
  }, []);

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
      setStatus("queued");
      setProgress("Adding to processing queue...");

      const splitRes = await fetch(`${API}/api/split/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });

      if (!splitRes.ok) {
        const err = await splitRes.json();
        throw new Error(err.error || "Splitting failed");
      }

      // Start SSE for real-time progress
      startSSE(id);

    } catch (err: any) {
      setStatus("error");
      setError(err.message);
      setProgress("");
    }
  };

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // Warn before navigating away during processing
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (status === "uploading" || status === "processing" || status === "queued") {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [status]);

  return (
    <div className="app" data-theme={theme}>
      <header className="header">
        <div className="header-row">
          <h1>Track Splitter</h1>
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
        </div>
        <p className="subtitle">
          Upload a song and split it into individual instrument tracks using AI
        </p>
        <nav className="nav-tabs" role="tablist">
          <button
            className={`nav-tab ${view === "split" ? "active" : ""}`}
            onClick={() => setView("split")}
            role="tab"
            aria-selected={view === "split"}
          >
            Split
          </button>
          <button
            className={`nav-tab ${view === "library" ? "active" : ""}`}
            onClick={() => setView("library")}
            role="tab"
            aria-selected={view === "library"}
          >
            Library
          </button>
        </nav>
      </header>

      <main className="main">
        {view === "library" ? (
          <Library onSelectJob={loadFromLibrary} onNewSplit={() => { reset(); setView("split"); }} />
        ) : status === "done" ? (
          <div className="results">
            <div className="results-header">
              <div>
                <h2>Separated Tracks</h2>
                <EditableName
                  name={displayName || file?.name || "track"}
                  onSave={handleRename}
                />
              </div>
              <div className="results-header-actions">
                <button className="btn btn-secondary btn-sm" onClick={() => setView("library")}>
                  Library
                </button>
                <button className="btn btn-secondary btn-sm" onClick={reset}>
                  Split Another Song
                </button>
              </div>
            </div>

            <Mixer
              key={jobId}
              tracks={tracks}
              jobId={jobId!}
              fileName={displayName || file?.name || "track"}
              initialSettings={mixerSettings}
              onNameChange={handleRename}
              jobName={jobName}
            />
          </div>
        ) : (
          <div className="upload-section">
            <UploadZone
              onFileSelected={handleFileSelected}
              disabled={status === "uploading" || status === "processing" || status === "queued"}
            />

            {file && status === "idle" && (
              <div className="file-info">
                <span className="file-name">{file.name}</span>
                <span className="file-size">{formatBytes(file.size)}</span>
              </div>
            )}

            {(status === "idle" && file) && (
              <div className="options">
                <label className="model-label" id="model-select-label">Separation model:</label>
                <div className="model-select" role="radiogroup" aria-labelledby="model-select-label">
                  {MODELS.map((m) => (
                    <button
                      key={m.id}
                      className={`model-option ${model === m.id ? "active" : ""}`}
                      onClick={() => setModel(m.id)}
                      role="radio"
                      aria-checked={model === m.id}
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

            {(status === "uploading" || status === "processing" || status === "queued") && (
              <ProgressDisplay progress={progress} status={status} />
            )}

            {status === "error" && (
              <div className="error-box" role="alert">
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
