import { beforeEach, describe, expect, it, vi } from "vitest";

const openAiMocks = vi.hoisted(() => ({
  create: vi.fn(),
  toFile: vi.fn()
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    audio: {
      transcriptions: {
        create: openAiMocks.create
      }
    }
  })),
  toFile: openAiMocks.toFile
}));

import { AudioTranscriptionService } from "../src/modules/audio/audioTranscriptionService";

describe("audio transcription service", () => {
  beforeEach(() => {
    openAiMocks.create.mockReset();
    openAiMocks.toFile.mockReset();
    openAiMocks.toFile.mockResolvedValue("file-like");
  });

  it("transcribes audio with the configured OpenAI model", async () => {
    openAiMocks.create.mockResolvedValue({ text: "  show my asana tasks  " });

    const result = await new AudioTranscriptionService("test-key", "gpt-4o-mini-transcribe").transcribe({
      buffer: Buffer.from([1, 2, 3]),
      filename: "voice.ogg",
      mimeType: "audio/ogg"
    });

    expect(openAiMocks.toFile).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), "voice.ogg", {
      type: "audio/ogg"
    });
    expect(openAiMocks.create).toHaveBeenCalledWith({
      model: "gpt-4o-mini-transcribe",
      file: "file-like"
    });
    expect(result).toEqual({
      text: "show my asana tasks",
      model: "gpt-4o-mini-transcribe"
    });
  });

  it("rejects empty transcripts", async () => {
    openAiMocks.create.mockResolvedValue({ text: "   " });

    await expect(
      new AudioTranscriptionService("test-key", "gpt-4o-mini-transcribe").transcribe({
        buffer: Buffer.from([1]),
        filename: "voice.ogg",
        mimeType: "audio/ogg"
      })
    ).rejects.toMatchObject({
      code: "AUDIO_TRANSCRIPT_EMPTY"
    });
  });

  it("maps transcription failures to a user-facing error", async () => {
    openAiMocks.create.mockRejectedValue(new Error("upstream"));

    await expect(
      new AudioTranscriptionService("test-key", "gpt-4o-mini-transcribe").transcribe({
        buffer: Buffer.from([1]),
        filename: "voice.ogg",
        mimeType: "audio/ogg"
      })
    ).rejects.toMatchObject({
      code: "AUDIO_TRANSCRIPTION_FAILED"
    });
  });
});
