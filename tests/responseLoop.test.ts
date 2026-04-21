import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runResponseLoop } from "../src/modules/agent/responseLoop";
import type { ResponsesClient } from "../src/lib/openaiClient";

describe("response loop", () => {
  it("stops after the configured max tool rounds", async () => {
    const client: ResponsesClient = {
      createResponse: vi.fn(async () => ({
        output: [
          {
            type: "function_call",
            call_id: crypto.randomUUID(),
            name: "calendar_list_events",
            arguments: JSON.stringify({
              timeMin: "2026-04-21T00:00:00.000Z",
              timeMax: "2026-04-22T00:00:00.000Z"
            })
          }
        ]
      }))
    };

    const executeTool = vi.fn(async () => ({ ok: true, data: [] }));

    const result = await runResponseLoop({
      client,
      model: "gpt-5.4",
      instructions: "test",
      tools: [],
      input: [{ role: "user", content: "what is tomorrow?" }],
      executeTool,
      maxToolRounds: 3
    });

    expect(result.stoppedForMaxRounds).toBe(true);
    expect(result.toolRounds).toBe(3);
    expect(executeTool).toHaveBeenCalledTimes(3);
  });

  it("short-circuits when a tool returns an approval request", async () => {
    const client: ResponsesClient = {
      createResponse: vi.fn(async () => ({
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "gmail_create_draft",
            arguments: JSON.stringify({
              to: "brad@example.com",
              subject: "Meeting",
              body: "Thursday works."
            })
          }
        ]
      }))
    };

    const result = await runResponseLoop({
      client,
      model: "gpt-5.4",
      instructions: "test",
      tools: [],
      input: [{ role: "user", content: "draft email" }],
      executeTool: vi.fn(async () => ({
        ok: true,
        approvalRequired: true,
        userMessage: "Draft ready. Reply SEND to send it."
      })),
      maxToolRounds: 3
    });

    expect(result.stoppedForApproval).toBe(true);
    expect(result.assistantMessage).toBe("Draft ready. Reply SEND to send it.");
  });

  it("returns a successful tool message directly when requested", async () => {
    const client: ResponsesClient = {
      createResponse: vi.fn(async () => ({
        output: [
          {
            type: "function_call",
            call_id: "call_2",
            name: "gmail_create_draft",
            arguments: JSON.stringify({
              to: "brad@example.com",
              subject: "Meeting",
              body: "Thursday works."
            })
          }
        ]
      }))
    };

    const result = await runResponseLoop({
      client,
      model: "gpt-5.4",
      instructions: "test",
      tools: [],
      input: [{ role: "user", content: "draft email" }],
      executeTool: vi.fn(async () => ({
        ok: true,
        stopAfterTool: true,
        userMessage: "Draft ready.\n\nTo: brad@example.com"
      })),
      maxToolRounds: 3
    });

    expect(result.assistantMessage).toBe("Draft ready.\n\nTo: brad@example.com");
    expect(result.toolRounds).toBe(0);
  });
});
