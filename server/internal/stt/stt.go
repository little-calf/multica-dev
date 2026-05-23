package stt

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
)

var (
	ErrNotConfigured    = errors.New("stt not configured")
	ErrAudioTooLarge    = errors.New("audio too large")
	ErrUnsupportedAudio = errors.New("unsupported audio")
)

type Audio struct {
	Reader      io.Reader
	Filename    string
	ContentType string
	SizeBytes   int64
}

type TranscribeOptions struct {
	Language string
	Prompt   string
	Target   string
}

type Transcript struct {
	Text     string
	Language string
	Duration time.Duration
	Provider string
	Model    string
}

type Provider interface {
	Name() string
	Transcribe(ctx context.Context, audio Audio, opts TranscribeOptions) (Transcript, error)
}

type Service struct {
	Provider      Provider
	MaxAudioBytes int64
	Timeout       time.Duration
}

func NewFromEnv() *Service {
	maxMB := int64(25)
	if raw := strings.TrimSpace(os.Getenv("STT_MAX_AUDIO_MB")); raw != "" {
		if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil && parsed > 0 {
			maxMB = parsed
		}
	}
	timeout := 60 * time.Second
	if raw := strings.TrimSpace(os.Getenv("STT_TIMEOUT")); raw != "" {
		if parsed, err := time.ParseDuration(raw); err == nil && parsed > 0 {
			timeout = parsed
		}
	}
	return &Service{
		Provider:      newProviderFromEnv(),
		MaxAudioBytes: maxMB << 20,
		Timeout:       timeout,
	}
}

func (s *Service) Transcribe(ctx context.Context, audio Audio, opts TranscribeOptions) (Transcript, error) {
	if s == nil || s.Provider == nil {
		return Transcript{}, ErrNotConfigured
	}
	if audio.SizeBytes <= 0 || audio.SizeBytes > s.MaxAudioBytes {
		return Transcript{}, ErrAudioTooLarge
	}
	if !IsSupportedAudioType(audio.ContentType, audio.Filename) {
		return Transcript{}, ErrUnsupportedAudio
	}
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	tctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return s.Provider.Transcribe(tctx, audio, opts)
}

func IsSupportedAudioType(contentType, filename string) bool {
	ct := strings.ToLower(strings.TrimSpace(contentType))
	if strings.HasPrefix(ct, "audio/") {
		return true
	}
	ext := strings.ToLower(path.Ext(filename))
	switch ext {
	case ".webm", ".mp3", ".mp4", ".m4a", ".wav", ".ogg":
		return true
	default:
		return false
	}
}

type openAIProvider struct {
	apiKey string
	model  string
	client *http.Client
}

func newProviderFromEnv() Provider {
	provider := strings.ToLower(strings.TrimSpace(os.Getenv("STT_PROVIDER")))
	if provider == "" {
		provider = "openai"
	}
	switch provider {
	case "openai":
		key := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
		if key == "" {
			return nil
		}
		model := strings.TrimSpace(os.Getenv("OPENAI_STT_MODEL"))
		if model == "" {
			model = "whisper-1"
		}
		return &openAIProvider{apiKey: key, model: model, client: &http.Client{Timeout: 70 * time.Second}}
	default:
		return nil
	}
}

func (p *openAIProvider) Name() string { return "openai" }

type openAITranscribeResp struct {
	Text     string `json:"text"`
	Language string `json:"language"`
}

func (p *openAIProvider) Transcribe(ctx context.Context, audio Audio, opts TranscribeOptions) (Transcript, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", audio.Filename)
	if err != nil {
		return Transcript{}, fmt.Errorf("create form file: %w", err)
	}
	if _, err := io.Copy(part, audio.Reader); err != nil {
		return Transcript{}, fmt.Errorf("copy audio: %w", err)
	}
	_ = writer.WriteField("model", p.model)
	if opts.Language != "" {
		_ = writer.WriteField("language", opts.Language)
	}
	if opts.Prompt != "" {
		_ = writer.WriteField("prompt", opts.Prompt)
	}
	if err := writer.Close(); err != nil {
		return Transcript{}, fmt.Errorf("close multipart writer: %w", err)
	}

	started := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.openai.com/v1/audio/transcriptions", &body)
	if err != nil {
		return Transcript{}, err
	}
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := p.client.Do(req)
	if err != nil {
		return Transcript{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return Transcript{}, fmt.Errorf("openai transcribe failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var decoded openAITranscribeResp
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return Transcript{}, fmt.Errorf("decode openai response: %w", err)
	}
	return Transcript{
		Text:     decoded.Text,
		Language: decoded.Language,
		Duration: time.Since(started),
		Provider: p.Name(),
		Model:    p.model,
	}, nil
}
