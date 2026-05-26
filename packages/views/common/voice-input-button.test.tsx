import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../locales/en/common.json";
import enModals from "../locales/en/modals.json";
import { VoiceInputButton } from "./voice-input-button";

const mockUploadFile = vi.hoisted(() => vi.fn());
const mockTranscribeAudio = vi.hoisted(() => vi.fn());
const mockDeleteAttachment = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {
    uploadFile: (...args: unknown[]) => mockUploadFile(...args),
    transcribeAudio: (...args: unknown[]) => mockTranscribeAudio(...args),
    deleteAttachment: (...args: unknown[]) => mockDeleteAttachment(...args),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

const TEST_RESOURCES = {
  en: { common: enCommon, modals: enModals },
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderWithI18n(ui: ReactNode) {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {ui}
    </I18nProvider>,
  );
}

class MediaRecorderMock {
  static isTypeSupported(type: string) {
    return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].includes(type);
  }

  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state: "inactive" | "recording" = "inactive";
  mimeType: string;

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "audio/webm";
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    const blob = new Blob(["mock-audio"], { type: this.mimeType });
    this.ondataavailable?.({ data: blob });
    this.onstop?.();
  }
}

describe("VoiceInputButton", () => {
  const originalMediaRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;

  beforeEach(() => {
    mockUploadFile.mockReset();
    mockTranscribeAudio.mockReset();
    mockDeleteAttachment.mockReset();
    mockToastError.mockReset();

    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = MediaRecorderMock;
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", {
        value: {},
        configurable: true,
      });
    }
    navigator.mediaDevices.getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream));
  });

  afterEach(() => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = originalMediaRecorder;
    if (originalGetUserMedia) {
      navigator.mediaDevices.getUserMedia = originalGetUserMedia;
    }
  });

  it("records, uploads, transcribes, deletes the temporary attachment, and emits text", async () => {
    const onText = vi.fn();
    mockUploadFile.mockResolvedValue({ id: "att-1" });
    mockTranscribeAudio.mockResolvedValue({ text: "transcribed title" });
    mockDeleteAttachment.mockResolvedValue(undefined);

    renderWithI18n(<VoiceInputButton target="issue_title" onText={onText} />);

    const button = screen.getByRole("button", { name: /voice input/i });
    await userEvent.click(button);
    await userEvent.click(screen.getByRole("button", { name: /stop recording/i }));

    await waitFor(() => {
      expect(mockUploadFile).toHaveBeenCalledTimes(1);
      expect(mockTranscribeAudio).toHaveBeenCalledWith({
        attachment_id: "att-1",
        target: "issue_title",
      });
      expect(onText).toHaveBeenCalledWith("transcribed title");
      expect(mockDeleteAttachment).toHaveBeenCalledWith("att-1");
    });
  });

  it("shows permission error toast when microphone access is denied", async () => {
    navigator.mediaDevices.getUserMedia = vi.fn(async () => {
      throw new Error("permission denied");
    });

    renderWithI18n(<VoiceInputButton target="issue_description" onText={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /voice input/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
      expect(mockUploadFile).not.toHaveBeenCalled();
      expect(mockTranscribeAudio).not.toHaveBeenCalled();
    });
  });

  it("cancels recording on unmount without uploading or transcribing", async () => {
    const onText = vi.fn();
    const view = renderWithI18n(
      <VoiceInputButton target="issue_description" onText={onText} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /voice input/i }));
    view.unmount();

    await waitFor(() => {
      expect(mockUploadFile).not.toHaveBeenCalled();
      expect(mockTranscribeAudio).not.toHaveBeenCalled();
      expect(mockToastError).not.toHaveBeenCalled();
      expect(onText).not.toHaveBeenCalled();
    });
  });

  it("ignores in-flight transcription results after unmount", async () => {
    const onText = vi.fn();
    const transcribeDeferred = createDeferred<{ text: string }>();
    mockUploadFile.mockResolvedValue({ id: "att-1" });
    mockTranscribeAudio.mockReturnValue(transcribeDeferred.promise);
    mockDeleteAttachment.mockResolvedValue(undefined);

    const view = renderWithI18n(<VoiceInputButton target="issue_title" onText={onText} />);

    await userEvent.click(screen.getByRole("button", { name: /voice input/i }));
    await userEvent.click(screen.getByRole("button", { name: /stop recording/i }));

    await waitFor(() => {
      expect(mockUploadFile).toHaveBeenCalledTimes(1);
      expect(mockTranscribeAudio).toHaveBeenCalledTimes(1);
    });

    view.unmount();
    transcribeDeferred.resolve({ text: "" });

    await waitFor(() => {
      expect(onText).not.toHaveBeenCalled();
      expect(mockToastError).not.toHaveBeenCalled();
      expect(mockDeleteAttachment).toHaveBeenCalledWith("att-1");
    });
  });

  it("deletes the temporary attachment when transcription fails", async () => {
    const onText = vi.fn();
    mockUploadFile.mockResolvedValue({ id: "att-2" });
    mockTranscribeAudio.mockRejectedValue(new Error("transcription failed"));
    mockDeleteAttachment.mockResolvedValue(undefined);

    renderWithI18n(<VoiceInputButton target="issue_description" onText={onText} />);

    await userEvent.click(screen.getByRole("button", { name: /voice input/i }));
    await userEvent.click(screen.getByRole("button", { name: /stop recording/i }));

    await waitFor(() => {
      expect(mockDeleteAttachment).toHaveBeenCalledWith("att-2");
      expect(mockToastError).toHaveBeenCalledWith("transcription failed");
      expect(onText).not.toHaveBeenCalled();
    });
  });
});
