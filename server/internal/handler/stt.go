package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/multica-ai/multica/server/internal/stt"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type TranscribeAudioRequest struct {
	AttachmentID string `json:"attachment_id"`
	Target       string `json:"target,omitempty"`
	Language     string `json:"language,omitempty"`
	Prompt       string `json:"prompt,omitempty"`
}

type TranscribeAudioResponse struct {
	Text         string `json:"text"`
	Language     string `json:"language,omitempty"`
	DurationMS   int64  `json:"duration_ms,omitempty"`
	AttachmentID string `json:"attachment_id"`
}

func (h *Handler) TranscribeAudio(w http.ResponseWriter, r *http.Request) {
	if h.Storage == nil {
		writeError(w, http.StatusServiceUnavailable, "file upload not configured")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace context is required")
		return
	}
	if _, err := h.getWorkspaceMember(r.Context(), userID, workspaceID); err != nil {
		writeError(w, http.StatusForbidden, "not a member of this workspace")
		return
	}
	var req TranscribeAudioRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.AttachmentID == "" {
		writeError(w, http.StatusBadRequest, "attachment_id is required")
		return
	}
	attID, ok := parseUUIDOrBadRequest(w, req.AttachmentID, "attachment_id")
	if !ok {
		return
	}
	att, err := h.Queries.GetAttachment(r.Context(), db.GetAttachmentParams{
		ID:          attID,
		WorkspaceID: parseUUID(workspaceID),
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "attachment not found")
		return
	}
	if !stt.IsSupportedAudioType(att.ContentType, att.Filename) {
		writeError(w, http.StatusBadRequest, "unsupported audio type")
		return
	}
	if h.STT == nil {
		writeError(w, http.StatusServiceUnavailable, "voice input is not configured")
		return
	}
	key := h.Storage.KeyFromURL(att.Url)
	reader, err := h.Storage.GetReader(r.Context(), key)
	if err != nil {
		slog.Error("stt: failed to read attachment", "attachment_id", req.AttachmentID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read audio")
		return
	}
	defer reader.Close()
	tr, err := h.STT.Transcribe(r.Context(), stt.Audio{
		Reader:      io.LimitReader(reader, att.SizeBytes+1),
		Filename:    att.Filename,
		ContentType: att.ContentType,
		SizeBytes:   att.SizeBytes,
	}, stt.TranscribeOptions{
		Language: req.Language,
		Prompt:   req.Prompt,
		Target:   req.Target,
	})
	if err != nil {
		slog.Error("stt: transcribe failed", "attachment_id", req.AttachmentID, "target", req.Target, "error", err)
		switch {
		case errors.Is(err, stt.ErrNotConfigured):
			writeError(w, http.StatusServiceUnavailable, "voice input is not configured")
		case errors.Is(err, stt.ErrAudioTooLarge):
			writeError(w, http.StatusRequestEntityTooLarge, "audio too large")
		case errors.Is(err, stt.ErrUnsupportedAudio):
			writeError(w, http.StatusBadRequest, "unsupported audio type")
		case errors.Is(err, context.DeadlineExceeded):
			writeError(w, http.StatusGatewayTimeout, "stt request timed out")
		default:
			writeError(w, http.StatusServiceUnavailable, "failed to transcribe audio")
		}
		return
	}
	writeJSON(w, http.StatusOK, TranscribeAudioResponse{
		Text:         tr.Text,
		Language:     tr.Language,
		DurationMS:   tr.Duration.Milliseconds(),
		AttachmentID: req.AttachmentID,
	})
}
