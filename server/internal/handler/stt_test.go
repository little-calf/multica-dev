package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/stt"
)

type fakeSTTProvider struct {
	text string
}

func (f *fakeSTTProvider) Name() string { return "fake" }
func (f *fakeSTTProvider) Transcribe(_ context.Context, _ stt.Audio, _ stt.TranscribeOptions) (stt.Transcript, error) {
	return stt.Transcript{Text: f.text, Language: "en"}, nil
}

func uploadTestAudioAttachment(t *testing.T, filename string, content []byte) string {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/upload-file", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("X-User-ID", testUserID)
	req.Header.Set("X-Workspace-ID", testWorkspaceID)

	w := httptest.NewRecorder()
	testHandler.UploadFile(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("upload failed: %d %s", w.Code, w.Body.String())
	}
	var resp struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode upload response: %v", err)
	}
	if resp.ID == "" {
		t.Fatalf("expected uploaded attachment id, got empty: %s", w.Body.String())
	}
	return resp.ID
}

func TestTranscribeAudioHappyPath(t *testing.T) {
	origStorage := testHandler.Storage
	origSTT := testHandler.STT
	testHandler.Storage = &mockStorage{}
	testHandler.STT = &stt.Service{Provider: &fakeSTTProvider{text: "hello stt"}, MaxAudioBytes: 25 << 20}
	defer func() {
		testHandler.Storage = origStorage
		testHandler.STT = origSTT
	}()

	attID := uploadTestAudioAttachment(t, "voice.webm", []byte("RIFF....WEBM"))
	req := newRequest(http.MethodPost, "/api/stt/transcribe", map[string]any{
		"attachment_id": attID,
		"target":        "issue_title",
	})
	w := httptest.NewRecorder()
	testHandler.TranscribeAudio(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("TranscribeAudio: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp TranscribeAudioResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Text != "hello stt" {
		t.Fatalf("expected text hello stt, got %q", resp.Text)
	}
	if resp.AttachmentID != attID {
		t.Fatalf("expected attachment_id %q, got %q", attID, resp.AttachmentID)
	}
}

func TestTranscribeAudioNotConfigured(t *testing.T) {
	origStorage := testHandler.Storage
	origSTT := testHandler.STT
	testHandler.Storage = &mockStorage{}
	testHandler.STT = nil
	defer func() {
		testHandler.Storage = origStorage
		testHandler.STT = origSTT
	}()

	attID := uploadTestAudioAttachment(t, "voice.webm", []byte("RIFF....WEBM"))
	req := newRequest(http.MethodPost, "/api/stt/transcribe", map[string]any{
		"attachment_id": attID,
	})
	w := httptest.NewRecorder()
	testHandler.TranscribeAudio(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("TranscribeAudio: expected 503, got %d: %s", w.Code, w.Body.String())
	}
}

func TestTranscribeAudioRejectsUnsupportedFile(t *testing.T) {
	origStorage := testHandler.Storage
	origSTT := testHandler.STT
	testHandler.Storage = &mockStorage{}
	testHandler.STT = &stt.Service{Provider: &fakeSTTProvider{text: "ignored"}, MaxAudioBytes: 25 << 20}
	defer func() {
		testHandler.Storage = origStorage
		testHandler.STT = origSTT
	}()

	attID := uploadTestAudioAttachment(t, "note.txt", []byte("not audio"))
	req := newRequest(http.MethodPost, "/api/stt/transcribe", map[string]any{
		"attachment_id": attID,
	})
	w := httptest.NewRecorder()
	testHandler.TranscribeAudio(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("TranscribeAudio: expected 400, got %d: %s", w.Code, w.Body.String())
	}
}
