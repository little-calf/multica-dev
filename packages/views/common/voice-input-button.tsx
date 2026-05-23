"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import { useT } from "../i18n";

type Stage = "idle" | "permission" | "recording" | "uploading" | "transcribing";

interface VoiceInputButtonProps {
  target: "issue_title" | "issue_description";
  onText: (text: string) => void;
  disabled?: boolean;
  className?: string;
}

function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "";
}

export function VoiceInputButton({ target, onText, disabled, className }: VoiceInputButtonProps) {
  const { t } = useT("modals");
  const [stage, setStage] = useState<Stage>("idle");
  const chunksRef = useRef<BlobPart[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanup = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
    }
    streamRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const transcribeBlob = useCallback(async (blob: Blob) => {
    setStage("uploading");
    const ext = blob.type.includes("mp4") ? "mp4" : "webm";
    const file = new File([blob], `voice-input-${Date.now()}.${ext}`, {
      type: blob.type || "audio/webm",
    });
    const uploaded = await api.uploadFile(file);
    setStage("transcribing");
    const transcribed = await api.transcribeAudio({ attachment_id: uploaded.id, target });
    const text = transcribed.text.trim();
    if (!text) {
      toast.error(t(($) => $.create_issue.voice.no_speech));
      return;
    }
    onText(text);
  }, [onText, target]);

  const start = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error(t(($) => $.create_issue.voice.unsupported_browser));
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      toast.error(t(($) => $.create_issue.voice.unsupported_browser));
      return;
    }

    setStage("permission");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        try {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
          if (blob.size === 0) {
            return;
          }
          await transcribeBlob(blob);
        } catch (error) {
          const message = error instanceof Error ? error.message : t(($) => $.create_issue.voice.transcribe_failed);
          toast.error(message || t(($) => $.create_issue.voice.transcribe_failed));
        } finally {
          cleanup();
          setStage("idle");
        }
      };

      recorder.start();
      setStage("recording");
      timeoutRef.current = setTimeout(() => {
        if (recorder.state === "recording") {
          recorder.stop();
        }
      }, 60_000);
    } catch {
      cleanup();
      setStage("idle");
      toast.error(t(($) => $.create_issue.voice.permission_required));
    }
  }, [cleanup, transcribeBlob]);

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
    }
  }, []);

  const isBusy = stage !== "idle";
  const isRecording = stage === "recording";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={className}
      disabled={disabled || (isBusy && !isRecording)}
      onClick={isRecording ? stop : start}
      aria-label={isRecording ? t(($) => $.create_issue.voice.stop_recording) : t(($) => $.create_issue.voice.input)}
      title={isRecording ? t(($) => $.create_issue.voice.stop_recording) : t(($) => $.create_issue.voice.input)}
    >
      {stage === "permission" || stage === "uploading" || stage === "transcribing" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : isRecording ? (
        <Square className="h-4 w-4" />
      ) : (
        <Mic className="h-4 w-4" />
      )}
    </Button>
  );
}
