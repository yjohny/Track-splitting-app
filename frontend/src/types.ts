export interface Track {
  name: string;
  filename: string;
}

export interface Model {
  id: string;
  label: string;
  desc: string;
}

export type AppStatus = "idle" | "uploading" | "queued" | "processing" | "done" | "error";
export type ExportFormat = "wav" | "mp3" | "flac";
export type Theme = "dark" | "light";

export interface ProgressEvent {
  status: string;
  progress?: string;
  tracks?: Track[];
  error?: string;
}

export interface MixerSettings {
  volumes: Record<string, number>;
  mutes: Record<string, boolean>;
  solos: Record<string, boolean>;
  trackOrder: string[];
  transposition?: number;
}

export interface LibraryJob {
  id: string;
  name: string | null;
  filename: string;
  status: string;
  trackCount: number;
  createdAt: number;
}
