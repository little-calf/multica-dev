"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import { useT } from "../i18n";

type Stage = "idle" | "permission" | "recording" | "uploading" | "transcribing";
type VoiceInputTarget = "issue_title" | "issue_description" | "quick_create_prompt";

interface VoiceInputButtonProps {
  target: VoiceInputTarget;
  onText: (text: string) => void;
  onBusyChange?: (busy: boolean) => void;
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

export function VoiceInputButton({
  target,
  onText,
  onBusyChange,
  disabled,
  className,
}: VoiceInputButtonProps) {
  const { t } = useT("modals");
  const [stage, setStage] = useState<Stage>("idle");
  const chunksRef = useRef<BlobPart[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const cancelRequestedRef = useRef(false);

  const setStageIfMounted = useCallback((nextStage: Stage) => {
    if (mountedRef.current) {
      setStage(nextStage);
    }
  }, []);

  const releaseMedia = useCallback((detachRecorderHandlers = false) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    const recorder = recorderRef.current;
    if (recorder) {
      if (detachRecorderHandlers) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
      }
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    }
    recorderRef.current = null;
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
    }
    streamRef.current = null;
    chunksRef.current = [];
  }, []);

  const cancel = useCallback(() => {
    cancelRequestedRef.current = true;
    releaseMedia(true);
    setStageIfMounted("idle");
  }, [releaseMedia, setStageIfMounted]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancel();
    };
  }, [cancel]);

  useEffect(() => {
    onBusyChange?.(stage !== "idle");
  }, [onBusyChange, stage]);

  const deleteTemporaryAttachment = useCallback(async (attachmentId: string | null) => {
    if (!attachmentId) {
      return;
    }
    try {
      await api.deleteAttachment(attachmentId);
    } catch (error) {
      console.error("[voice-input] failed to delete temporary attachment", error);
    }
  }, []);

  const transcribeBlob = useCallback(async (blob: Blob) => {
    let temporaryAttachmentId: string | null = null;
    if (cancelRequestedRef.current) {
      return;
    }
    try {
      setStageIfMounted("uploading");
      const ext = blob.type.includes("mp4") ? "mp4" : "webm";
      const file = new File([blob], `voice-input-${Date.now()}.${ext}`, {
        type: blob.type || "audio/webm",
      });
      const uploaded = await api.uploadFile(file);
      temporaryAttachmentId = uploaded.id;
      if (cancelRequestedRef.current) {
        return;
      }
      setStageIfMounted("transcribing");
      const transcribed = await api.transcribeAudio({ attachment_id: uploaded.id, target });
      if (cancelRequestedRef.current) {
        return;
      }
      const text = transcribed.text.trim();
      if (!text) {
        toast.error(t(($) => $.create_issue.voice.no_speech));
        return;
      }
      onText(text);
    } finally {
      await deleteTemporaryAttachment(temporaryAttachmentId);
    }
  }, [deleteTemporaryAttachment, onText, setStageIfMounted, t, target]);

  const start = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error(t(($) => $.create_issue.voice.unsupported_browser));
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      toast.error(t(($) => $.create_issue.voice.unsupported_browser));
      return;
    }

    cancelRequestedRef.current = false;
    setStageIfMounted("permission");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (cancelRequestedRef.current || !mountedRef.current) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }
      const mimeType = pickMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (!cancelRequestedRef.current && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        try {
          if (cancelRequestedRef.current) {
            return;
          }
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
          if (cancelRequestedRef.current || blob.size === 0) {
            return;
          }
          await transcribeBlob(blob);
        } catch (error) {
          if (cancelRequestedRef.current) {
            return;
          }
          const message = error instanceof Error ? error.message : t(($) => $.create_issue.voice.transcribe_failed);
          toast.error(message || t(($) => $.create_issue.voice.transcribe_failed));
        } finally {
          releaseMedia(true);
          setStageIfMounted("idle");
        }
      };

      recorder.start();
      setStageIfMounted("recording");
      timeoutRef.current = setTimeout(() => {
        if (recorder.state === "recording") {
          recorder.stop();
        }
      }, 60_000);
    } catch {
      releaseMedia(true);
      setStageIfMounted("idle");
      if (!cancelRequestedRef.current) {
        toast.error(t(($) => $.create_issue.voice.permission_required));
      }
    }
  }, [releaseMedia, setStageIfMounted, t, transcribeBlob]);

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
