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

  it("feeds formatted communication summaries back into the model", async () => {
    const client: ResponsesClient = {
      createResponse: vi
        .fn()
        .mockResolvedValueOnce({
          output: [
            {
              type: "function_call",
              call_id: "call_3",
              name: "asana_list_my_tasks",
              arguments: JSON.stringify({
                dueOn: "2026-04-23"
              })
            }
          ]
        })
        .mockResolvedValueOnce({
          output_text: "You have 1 task due today."
        })
    };

    const result = await runResponseLoop({
      client,
      model: "gpt-5.4",
      instructions: "test",
      tools: [],
      input: [{ role: "user", content: "show my tasks due today" }],
      executeTool: vi.fn(async () => ({
        ok: true,
        data: [
          {
            gid: "task_1",
            name: "Ship launch notes",
            completed: false
          }
        ]
      })),
      maxToolRounds: 3
    });

    expect(result.assistantMessage).toBe("You have 1 task due today.");
    const secondCall = (client.createResponse as any).mock.calls[1][0];
    const functionOutput = secondCall.input.find(
      (item: any) => item.type === "function_call_output" && item.call_id === "call_3"
    );

    expect(JSON.parse(functionOutput.output)).toMatchObject({
      communication: {
        app: "asana",
        summary: "Found 1 Asana task.",
        referenceEntities: [
          {
            kind: "asana_task",
            id: "task_1",
            name: "Ship launch notes"
          }
        ]
      }
    });
  });

  it("executes multiple independent read tools in one round and feeds every output back", async () => {
    const client: ResponsesClient = {
      createResponse: vi
        .fn()
        .mockResolvedValueOnce({
          output: [
            {
              type: "function_call",
              call_id: "call_web",
              name: "web_search",
              arguments: JSON.stringify({
                query: "NVDA stock news today"
              })
            },
            {
              type: "function_call",
              call_id: "call_tasks",
              name: "asana_list_my_tasks",
              arguments: JSON.stringify({
                dueOn: "2026-04-24"
              })
            }
          ]
        })
        .mockResolvedValueOnce({
          output_text: "NVDA moved on chip demand, and you have 1 Asana task due today."
        })
    };

    const executeTool = vi.fn(async (toolName: string) =>
      toolName === "web_search"
        ? {
            ok: true,
            data: {
              query: "NVDA stock news today",
              summary: "NVDA rose on AI chip demand.",
              sources: []
            }
          }
        : {
            ok: true,
            data: [{ gid: "task_1", name: "Ship launch notes", completed: false }]
          }
    );

    const result = await runResponseLoop({
      client,
      model: "gpt-5.4",
      instructions: "test",
      tools: [],
      input: [{ role: "user", content: "why is NVDA up and show my tasks due today" }],
      executeTool,
      maxToolRounds: 3
    });

    expect(result.assistantMessage).toBe(
      "NVDA moved on chip demand, and you have 1 Asana task due today."
    );
    expect(executeTool).toHaveBeenCalledTimes(2);
    const secondCall = (client.createResponse as any).mock.calls[1][0];
    const functionOutputs = secondCall.input.filter(
      (item: any) => item.type === "function_call_output"
    );
    expect(functionOutputs.map((item: any) => item.call_id)).toEqual(["call_web", "call_tasks"]);
  });

  it("executes mixed read and write batches without dropping later calls", async () => {
    const client: ResponsesClient = {
      createResponse: vi
        .fn()
        .mockResolvedValueOnce({
          output: [
            {
              type: "function_call",
              call_id: "call_calendar",
              name: "calendar_create_event",
              arguments: JSON.stringify({
                title: "Trade decision",
                start: "2026-04-24T19:00:00.000Z",
                end: "2026-04-24T19:30:00.000Z"
              })
            },
            {
              type: "function_call",
              call_id: "call_web",
              name: "web_search",
              arguments: JSON.stringify({
                query: "NVDA stock news today"
              })
            }
          ]
        })
        .mockResolvedValueOnce({
          output_text: "Booked the reminder and found the NVDA summary."
        })
    };

    const executeTool = vi.fn(async (toolName: string) =>
      toolName === "calendar_create_event"
        ? {
            ok: true,
            data: {
              title: "Trade decision",
              start: "2026-04-24T19:00:00.000Z"
            },
            userMessage: "Booked: Trade decision at Apr 24, 2026, 3:00 PM."
          }
        : {
            ok: true,
            data: {
              query: "NVDA stock news today",
              summary: "NVDA rose on AI chip demand.",
              sources: []
            }
          }
    );

    const result = await runResponseLoop({
      client,
      model: "gpt-5.4",
      instructions: "test",
      tools: [],
      input: [{ role: "user", content: "why is NVDA up and add a calendar reminder" }],
      executeTool,
      maxToolRounds: 3
    });

    expect(result.assistantMessage).toBe("Booked the reminder and found the NVDA summary.");
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it("returns partial progress when one task succeeds and another fails", async () => {
    const client: ResponsesClient = {
      createResponse: vi.fn(async () => ({
        output: [
          {
            type: "function_call",
            call_id: "call_web",
            name: "web_search",
            arguments: JSON.stringify({
              query: "NVDA stock news today"
            })
          },
          {
            type: "function_call",
            call_id: "call_calendar",
            name: "calendar_list_events",
            arguments: JSON.stringify({
              timeMin: "2026-04-24T04:00:00.000Z",
              timeMax: "2026-04-25T04:00:00.000Z"
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
      input: [{ role: "user", content: "why is NVDA up and what is on my calendar" }],
      executeTool: vi.fn(async (toolName: string) =>
        toolName === "web_search"
          ? {
              ok: true,
              data: {
                query: "NVDA stock news today",
                summary: "NVDA rose on AI chip demand.",
                sources: []
              }
            }
          : {
              ok: false,
              error: "GOOGLE_AUTH_REQUIRED",
              userMessage: "Reconnect Google Calendar and try again."
            }
      ),
      maxToolRounds: 3
    });

    expect(result.assistantMessage).toContain("Completed:");
    expect(result.assistantMessage).toContain("Web: NVDA rose on AI chip demand.");
    expect(result.assistantMessage).toContain("Couldn't complete:");
    expect(result.assistantMessage).toContain("Calendar: Reconnect Google Calendar and try again.");
    expect((client.createResponse as any).mock.calls).toHaveLength(1);
  });

  it("does not let a Gmail draft stop other clear tasks in the same batch", async () => {
    const client: ResponsesClient = {
      createResponse: vi.fn(async () => ({
        output: [
          {
            type: "function_call",
            call_id: "call_draft",
            name: "gmail_create_draft",
            arguments: JSON.stringify({
              to: "brad@example.com",
              subject: "Meeting",
              body: "Thursday works."
            })
          },
          {
            type: "function_call",
            call_id: "call_web",
            name: "web_search",
            arguments: JSON.stringify({
              query: "NVDA stock news today"
            })
          }
        ]
      }))
    };

    const executeTool = vi.fn(async (toolName: string) =>
      toolName === "gmail_create_draft"
        ? {
            ok: true,
            stopAfterTool: true,
            userMessage: "Draft ready.\n\nTo: brad@example.com\nSubject: Meeting"
          }
        : {
            ok: true,
            data: {
              query: "NVDA stock news today",
              summary: "NVDA rose on AI chip demand.",
              sources: []
            }
          }
    );

    const result = await runResponseLoop({
      client,
      model: "gpt-5.4",
      instructions: "test",
      tools: [],
      input: [{ role: "user", content: "draft Brad an email and why is NVDA up" }],
      executeTool,
      maxToolRounds: 3
    });

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(result.assistantMessage).toContain("Gmail: Draft ready.");
    expect(result.assistantMessage).toContain("Web: NVDA rose on AI chip demand.");
    expect((client.createResponse as any).mock.calls).toHaveLength(1);
  });
});
