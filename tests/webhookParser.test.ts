import { describe, expect, it } from "vitest";
import { parseWhatsAppWebhook } from "../src/modules/whatsapp/webhookParser";

describe("WhatsApp webhook parser", () => {
  it("extracts text, audio, and statuses", () => {
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
                    image: { id: "image-id" }
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

    expect(parsed.messages).toHaveLength(2);
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
    expect(parsed.unsupportedMessages[0]!.type).toBe("image");
    expect(parsed.statuses[0]!.status).toBe("delivered");
  });
});
