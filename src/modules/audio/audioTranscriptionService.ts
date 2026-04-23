import OpenAI, { toFile } from "openai";
import { env } from "../../config/env";
import { UserFacingError } from "../../lib/errors";

export interface AudioTranscriptionInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface AudioTranscriptionResult {
  text: string;
  model: string;
}

export class AudioTranscriptionService {
  private readonly client: OpenAI;

  constructor(
    apiKey = env.OPENAI_API_KEY,
    private readonly model = env.OPENAI_TRANSCRIPTION_MODEL
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async transcribe(input: AudioTranscriptionInput): Promise<AudioTranscriptionResult> {
    try {
      const file = await toFile(input.buffer, input.filename, { type: input.mimeType });
      const result = await this.client.audio.transcriptions.create({
        model: this.model,
        file
      });
      const text = typeof result === "string" ? result : result.text;
      const normalizedText = text.trim();

      if (!normalizedText) {
        throw new UserFacingError(
          "Audio transcript empty",
          "AUDIO_TRANSCRIPT_EMPTY",
          "I didn't catch any speech in that voice message."
        );
      }

      return {
        text: normalizedText,
        model: this.model
      };
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      throw new UserFacingError(
        "Audio transcription failed",
        "AUDIO_TRANSCRIPTION_FAILED",
        "I couldn't understand that voice message. Please try again or send it as text."
      );
    }
  }
}
