import { env } from "../../config/env";
import { UserFacingError } from "../../lib/errors";

const GRAPH_API_BASE_URL = "https://graph.facebook.com/v20.0";

const SUPPORTED_AUDIO_MIME_TYPES = new Map<string, string>([
  ["audio/ogg", "ogg"],
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/m4a", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/wav", "wav"],
  ["audio/wave", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/webm", "webm"],
  ["video/mp4", "mp4"]
]);

interface WhatsAppMediaMetadataResponse {
  url?: string;
  mime_type?: string;
  sha256?: string;
  file_size?: number;
}

export interface DownloadedWhatsAppMedia {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  mediaId: string;
  sha256?: string;
}

export class WhatsAppMediaService {
  async downloadAudio(input: {
    mediaId: string;
    mimeType?: string;
    sha256?: string;
  }): Promise<DownloadedWhatsAppMedia> {
    const metadata = await this.getMediaMetadata(input.mediaId);
    const metadataMimeType = normalizeMimeType(metadata.mime_type ?? input.mimeType);
    const extension = extensionForMimeType(metadataMimeType);
    if (!extension) {
      throw new UserFacingError(
        "Unsupported WhatsApp audio type",
        "WHATSAPP_AUDIO_UNSUPPORTED",
        "I couldn't understand that voice message. Please try again or send it as text."
      );
    }

    if (metadata.file_size && metadata.file_size > env.WHATSAPP_MAX_AUDIO_BYTES) {
      throw new UserFacingError(
        "WhatsApp audio too large",
        "WHATSAPP_AUDIO_TOO_LARGE",
        "That voice message is too large to transcribe. Please send a shorter one."
      );
    }

    if (!metadata.url) {
      throw new UserFacingError(
        "WhatsApp media URL missing",
        "WHATSAPP_MEDIA_DOWNLOAD_FAILED",
        "I couldn't download that voice message. Please try sending it again."
      );
    }

    const response = await fetch(metadata.url, {
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`
      }
    });

    if (!response.ok) {
      throw this.mapError(response.status);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > env.WHATSAPP_MAX_AUDIO_BYTES) {
      throw new UserFacingError(
        "WhatsApp audio too large",
        "WHATSAPP_AUDIO_TOO_LARGE",
        "That voice message is too large to transcribe. Please send a shorter one."
      );
    }

    const downloadedMimeType = normalizeMimeType(
      response.headers.get("content-type") ?? metadataMimeType
    );
    const downloadedExtension = extensionForMimeType(downloadedMimeType);
    if (!downloadedExtension) {
      throw new UserFacingError(
        "Unsupported WhatsApp audio type",
        "WHATSAPP_AUDIO_UNSUPPORTED",
        "I couldn't understand that voice message. Please try again or send it as text."
      );
    }

    return {
      buffer,
      mediaId: input.mediaId,
      mimeType: downloadedMimeType,
      filename: `${input.mediaId}.${downloadedExtension}`,
      sha256: metadata.sha256 ?? input.sha256
    };
  }

  private async getMediaMetadata(mediaId: string): Promise<WhatsAppMediaMetadataResponse> {
    const url = new URL(`${GRAPH_API_BASE_URL}/${mediaId}`);
    url.searchParams.set("phone_number_id", env.WHATSAPP_PHONE_NUMBER_ID);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        Accept: "application/json"
      }
    });

    const payload = (await response.json().catch(() => ({}))) as WhatsAppMediaMetadataResponse;

    if (!response.ok) {
      throw this.mapError(response.status);
    }

    return payload;
  }

  private mapError(status: number): UserFacingError {
    if (status === 401 || status === 403) {
      return new UserFacingError(
        "WhatsApp media auth failed",
        "WHATSAPP_MEDIA_AUTH_FAILED",
        "I couldn't download that voice message. Please try sending it again."
      );
    }

    if (status === 404) {
      return new UserFacingError(
        "WhatsApp media not found",
        "WHATSAPP_MEDIA_NOT_FOUND",
        "I couldn't download that voice message. Please try sending it again."
      );
    }

    if (status === 429) {
      return new UserFacingError(
        "WhatsApp media rate limited",
        "WHATSAPP_MEDIA_RATE_LIMITED",
        "I couldn't download that voice message right now. Please try again in a minute."
      );
    }

    return new UserFacingError(
      "WhatsApp media download failed",
      "WHATSAPP_MEDIA_DOWNLOAD_FAILED",
      "I couldn't download that voice message. Please try sending it again."
    );
  }
}

function normalizeMimeType(mimeType?: string | null): string {
  return (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
}

function extensionForMimeType(mimeType: string): string | null {
  return SUPPORTED_AUDIO_MIME_TYPES.get(mimeType) ?? null;
}
