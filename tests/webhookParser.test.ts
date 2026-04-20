import { describe, expect, it } from "vitest";
import { parseWhatsAppWebhook } from "../src/modules/whatsapp/webhookParser";

describe("WhatsApp webhook parser", () => {
  it("extracts text messages and statuses", () => {
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
                    audio: { id: "audio-id" }
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

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]!.text).toContain("calendar");
    expect(parsed.unsupportedMessages[0]!.type).toBe("audio");
    expect(parsed.statuses[0]!.status).toBe("delivered");
  });
});
