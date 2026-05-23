package stt

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeProvider struct {
	out Transcript
	err error
}

func (f *fakeProvider) Name() string { return "fake" }
func (f *fakeProvider) Transcribe(_ context.Context, _ Audio, _ TranscribeOptions) (Transcript, error) {
	if f.err != nil {
		return Transcript{}, f.err
	}
	return f.out, nil
}

func TestIsSupportedAudioType(t *testing.T) {
	if !IsSupportedAudioType("audio/webm", "voice.webm") {
		t.Fatalf("expected audio/webm to be supported")
	}
	if !IsSupportedAudioType("application/octet-stream", "voice.mp3") {
		t.Fatalf("expected .mp3 extension to be supported")
	}
	if IsSupportedAudioType("text/plain", "note.txt") {
		t.Fatalf("expected text/plain .txt to be unsupported")
	}
}

func TestServiceTranscribeValidation(t *testing.T) {
	svc := &Service{Provider: nil, MaxAudioBytes: 1024, Timeout: time.Second}
	_, err := svc.Transcribe(context.Background(), Audio{Reader: strings.NewReader("x"), Filename: "a.webm", ContentType: "audio/webm", SizeBytes: 1}, TranscribeOptions{})
	if !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("expected ErrNotConfigured, got %v", err)
	}

	svc.Provider = &fakeProvider{out: Transcript{Text: "ok"}}
	_, err = svc.Transcribe(context.Background(), Audio{Reader: strings.NewReader("x"), Filename: "a.webm", ContentType: "audio/webm", SizeBytes: 2048}, TranscribeOptions{})
	if !errors.Is(err, ErrAudioTooLarge) {
		t.Fatalf("expected ErrAudioTooLarge, got %v", err)
	}

	_, err = svc.Transcribe(context.Background(), Audio{Reader: strings.NewReader("x"), Filename: "a.txt", ContentType: "text/plain", SizeBytes: 1}, TranscribeOptions{})
	if !errors.Is(err, ErrUnsupportedAudio) {
		t.Fatalf("expected ErrUnsupportedAudio, got %v", err)
	}

	out, err := svc.Transcribe(context.Background(), Audio{Reader: strings.NewReader("x"), Filename: "a.webm", ContentType: "audio/webm", SizeBytes: 1}, TranscribeOptions{})
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if out.Text != "ok" {
		t.Fatalf("expected transcript text 'ok', got %q", out.Text)
	}
}
