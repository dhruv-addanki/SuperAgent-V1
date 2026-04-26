import { describe, expect, it } from "vitest";
import { parseWhatsAppWebhook } from "../src/modules/whatsapp/webhookParser";

describe("WhatsApp webhook parser", () => {
  it("extracts text, audio, image, and statuses", () => {
    const parsed = parseWhatsAppWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.1",
                    from: "15555550100",
                    timestamp: "1776700000",
                    type: "text",
                    text: { body: "What's on my calendar tomorrow?" }
                  },
                  {
                    id: "wamid.2",
                    from: "15555550100",
                    timestamp: "1776700001",
                    type: "audio",
                    audio: {
                      id: "audio-id",
                      mime_type: "audio/ogg; codecs=opus",
                      sha256: "hash",
                      voice: true
                    }
                  },
                  {
                    id: "wamid.3",
                    from: "15555550100",
                    timestamp: "1776700002",
                    type: "image",
                    image: {
                      id: "image-id",
                      mime_type: "image/jpeg",
                      sha256: "image-hash",
                      caption: "what does this say?"
                    }
                  }
                ],
                statuses: [
                  {
                    id: "wamid.outbound",
                    recipient_id: "15555550100",
                    status: "delivered",
                    timestamp: "1776700002"
                  }
                ]
              }
            }
          ]
        }
      ]
    });

    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[0]).toMatchObject({
      kind: "text",
      text: expect.stringContaining("calendar")
    });
    expect(parsed.messages[1]).toMatchObject({
      kind: "audio",
      mediaId: "audio-id",
      mimeType: "audio/ogg; codecs=opus",
      sha256: "hash",
      isVoice: true
    });
    expect(parsed.messages[2]).toMatchObject({
      kind: "image",
      messageId: "wamid.3",
      from: "15555550100",
      mediaId: "image-id",
      mimeType: "image/jpeg",
      sha256: "image-hash",
      caption: "what does this say?"
    });
    expect(parsed.unsupportedMessages).toHaveLength(0);
    expect(parsed.statuses[0]!.status).toBe("delivered");
  });
});
