import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppMediaService } from "../src/modules/whatsapp/whatsappMediaService";

describe("whatsapp media service", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retrieves a media URL and downloads audio with bearer auth", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: "https://lookaside.example/audio",
          mime_type: "audio/ogg; codecs=opus",
          sha256: "hash"
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: headersWithContentType("audio/ogg"),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
      });

    const media = await new WhatsAppMediaService().downloadAudio({
      mediaId: "media_1",
      mimeType: "audio/ogg; codecs=opus"
    });

    expect(fetchMock.mock.calls[0][0].toString()).toBe(
      "https://graph.facebook.com/v20.0/media_1?phone_number_id=phone-id"
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer dev-whatsapp-token");
    expect(fetchMock.mock.calls[1][0]).toBe("https://lookaside.example/audio");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer dev-whatsapp-token");
    expect(media).toMatchObject({
      mediaId: "media_1",
      mimeType: "audio/ogg",
      filename: "media_1.ogg",
      sha256: "hash"
    });
    expect(media.buffer).toEqual(Buffer.from([1, 2, 3]));
  });

  it("maps metadata auth failures to a user-facing error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "Forbidden" } })
    });

    await expect(new WhatsAppMediaService().downloadAudio({ mediaId: "media_1" })).rejects.toMatchObject({
      code: "WHATSAPP_MEDIA_AUTH_FAILED"
    });
  });

  it("rejects unsupported downloaded media types", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: "https://lookaside.example/audio",
          mime_type: "audio/ogg"
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: headersWithContentType("text/html"),
        arrayBuffer: async () => new Uint8Array([1]).buffer
      });

    await expect(new WhatsAppMediaService().downloadAudio({ mediaId: "media_1" })).rejects.toMatchObject({
      code: "WHATSAPP_AUDIO_UNSUPPORTED"
    });
  });
});

function headersWithContentType(contentType: string): { get(name: string): string | null } {
  return {
    get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null)
  };
}
