import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import App from "./App";

// Mock AudioContext for tests
const mockAudioContext = {
  createMediaElementSource: jest.fn(() => ({
    connect: jest.fn(),
  })),
  createGain: jest.fn(() => ({
    gain: { value: 1 },
    connect: jest.fn(),
  })),
  close: jest.fn(),
  resume: jest.fn(),
  state: "running",
  destination: {},
  decodeAudioData: jest.fn(),
};

(window as any).AudioContext = jest.fn(() => mockAudioContext);
(window as any).webkitAudioContext = jest.fn(() => mockAudioContext);

// Mock fetch
global.fetch = jest.fn();

describe("App", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  test("renders the upload zone", () => {
    render(<App />);
    expect(screen.getByText(/Drop a music file here/i)).toBeInTheDocument();
  });

  test("renders the app title", () => {
    render(<App />);
    expect(screen.getByText("Track Splitter")).toBeInTheDocument();
  });

  test("shows file info after selecting a file", () => {
    render(<App />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["audio content"], "test-song.mp3", { type: "audio/mp3" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(screen.getByText("test-song.mp3")).toBeInTheDocument();
  });

  test("shows model selection after file is selected", () => {
    render(<App />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["audio content"], "test.mp3", { type: "audio/mp3" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(screen.getByText("HTDemucs (4 stems)")).toBeInTheDocument();
    expect(screen.getByText("HTDemucs 6-stem")).toBeInTheDocument();
  });

  test("theme toggle switches between dark and light", () => {
    render(<App />);
    const toggle = screen.getByLabelText(/Switch to light mode/i);
    fireEvent.click(toggle);

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");
  });

  test("split button appears after file selection", () => {
    render(<App />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["audio content"], "test.mp3", { type: "audio/mp3" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(screen.getByText("Split Track")).toBeInTheDocument();
  });

  test("upload zone is accessible with keyboard", () => {
    render(<App />);
    const uploadZone = screen.getByRole("button", { name: /Upload audio file/i });
    expect(uploadZone).toHaveAttribute("tabIndex", "0");
  });

  test("renders navigation tabs", () => {
    render(<App />);
    expect(screen.getByRole("tab", { name: "Split" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Library" })).toBeInTheDocument();
  });

  test("switches to library view when Library tab is clicked", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));

    expect(await screen.findByText("Your Library")).toBeInTheDocument();
    expect(await screen.findByText("No saved splits yet.")).toBeInTheDocument();
  });

  test("library displays jobs from API", async () => {
    const mockJobs = [
      { id: "abc123", name: "My Song", filename: "song.mp3", status: "done", trackCount: 4, createdAt: Date.now() / 1000 },
    ];
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockJobs,
    });

    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));

    expect(await screen.findByText("My Song")).toBeInTheDocument();
    expect(screen.getByText(/4 tracks/)).toBeInTheDocument();
  });
});
