import { describe, expect, it } from "vitest";
import {
  buildConversationContext,
  formatConversationContextForPrompt
} from "../src/modules/agent/conversationContext";
import { classifyIntentRoute } from "../src/modules/agent/intentRouter";

describe("conversation context", () => {
  it("keeps only active-app context while preserving user preferences", () => {
    const context = buildConversationContext({
      latestUserMessage: "append this to the same doc",
      memoryEntries: [
        {
          key: "recent_google_doc",
          value: {
            documentId: "doc_123",
            title: "Strategy Notes",
            url: "https://docs.google.com/document/d/doc_123/edit"
          },
          updatedAt: new Date("2026-04-23T00:00:00.000Z")
        },
        {
          key: "recent_asana_tasks",
          value: [
            {
              taskGid: "task_1",
              name: "Ship the launch plan"
            }
          ],
          updatedAt: new Date("2026-04-22T00:00:00.000Z")
        },
        {
          key: "preferred_email_tone",
          value: {
            tone: "direct"
          },
          updatedAt: new Date("2026-04-21T00:00:00.000Z")
        }
      ],
      pendingAction: null,
      pendingActionSummary: "No pending actions."
    });

    expect(context.activeApp).toBe("docs");
    expect(context.activeEntities).toEqual(["Google Doc: Strategy Notes (documentId: doc_123)"]);
    expect(context.recentResults).toEqual(["Current Google Doc: Strategy Notes."]);
    expect(context.communicationHints.join("\n")).toContain("delete it");
    expect(context.communicationHints.join("\n")).toContain("drive_delete_file");
    expect(context.userPreferences).toEqual(["Preferred email tone: direct"]);

    const formatted = formatConversationContextForPrompt(context);
    expect(formatted).toContain("Active app/workflow: docs");
    expect(formatted).toContain("Google Doc: Strategy Notes (documentId: doc_123)");
    expect(formatted).not.toContain("Ship the launch plan");
  });

  it("adds pending-action guidance for pronoun follow-ups", () => {
    const context = buildConversationContext({
      latestUserMessage: "send it",
      memoryEntries: [],
      pendingAction: {
        id: "pending_1"
      } as any,
      pendingActionSummary: "Pending action: email draft available."
    });

    expect(context.communicationHints).toContain(
      "If the user refers to the pending action with phrases like send it, confirm it, change it, or cancel it, treat that as the active target."
    );
    expect(context.pendingActionSummary).toBe("Pending action: email draft available.");
  });

  it("includes bounded context for every referenced app in multi-task messages", () => {
    const context = buildConversationContext({
      latestUserMessage: "What's on my calendar today and show my Asana tasks due today",
      memoryEntries: [
        {
          key: "recent_calendar_events",
          value: [
            {
              eventId: "event_1",
              title: "Physics",
              calendarId: "school"
            }
          ],
          updatedAt: new Date()
        },
        {
          key: "recent_asana_tasks",
          value: [
            {
              taskGid: "task_1",
              name: "Submit homework"
            }
          ],
          updatedAt: new Date()
        },
        {
          key: "recent_gmail_threads",
          value: [
            {
              threadId: "thread_1",
              subject: "Unrelated"
            }
          ],
          updatedAt: new Date()
        }
      ],
      pendingAction: null,
      pendingActionSummary: "No pending actions."
    });

    expect(context.activeApp).toBe("multi");
    expect(context.activeEntities).toContain(
      "Calendar event: Physics (eventId: event_1, calendarId: school)"
    );
    expect(context.activeEntities).toContain("Asana task: Submit homework (taskGid: task_1)");
    expect(context.activeEntities.join("\n")).not.toContain("Unrelated");
  });

  it("uses the central route instead of broad app detection when provided", () => {
    const intentRoute = classifyIntentRoute({ text: "schedule looks packed" });
    const context = buildConversationContext({
      latestUserMessage: "schedule looks packed",
      memoryEntries: [],
      pendingAction: null,
      pendingActionSummary: "No pending actions.",
      intentRoute
    });

    const formatted = formatConversationContextForPrompt(context);

    expect(context.activeApp).toBe("general");
    expect(formatted).toContain("Routing:");
    expect(formatted).toContain("Intent route: general/unknown/low");
  });

  it("drops stale recent context from the prompt assembly", () => {
    const context = buildConversationContext({
      latestUserMessage: "show my asana tasks",
      memoryEntries: [
        {
          key: "recent_asana_tasks",
          value: [
            {
              taskGid: "task_1",
              name: "Stale task"
            }
          ],
          updatedAt: new Date("2025-01-01T00:00:00.000Z")
        }
      ],
      pendingAction: null,
      pendingActionSummary: "No pending actions."
    });

    expect(context.activeApp).toBe("asana");
    expect(context.activeEntities).toEqual([]);
    expect(context.recentResults).toEqual([]);
  });

  it("resolves Notion page context for follow-up appends", () => {
    const context = buildConversationContext({
      latestUserMessage: "append this to the same Notion page",
      memoryEntries: [
        {
          key: "recent_notion_page",
          value: {
            pageId: "page_1",
            title: "Launch Notes",
            url: "https://notion.so/page_1"
          },
          updatedAt: new Date()
        },
        {
          key: "recent_asana_tasks",
          value: [
            {
              taskGid: "task_1",
              name: "Unrelated"
            }
          ],
          updatedAt: new Date()
        }
      ],
      pendingAction: null,
      pendingActionSummary: "No pending actions."
    });

    expect(context.activeApp).toBe("notion");
    expect(context.activeEntities).toEqual(["Notion page: Launch Notes (pageId: page_1)"]);
    expect(context.recentResults).toEqual(["Current Notion page: Launch Notes."]);
    expect(context.communicationHints[0]).toContain("same Notion page");
  });

  it("includes recent image context for screenshot follow-ups", () => {
    const context = buildConversationContext({
      latestUserMessage: "what does that screenshot say?",
      memoryEntries: [
        {
          key: "recent_image_context",
          value: {
            summary:
              "Visible text: Launch Notes. Visual context: Notion page screenshot. Likely user intent: read the screenshot."
          },
          updatedAt: new Date()
        }
      ],
      pendingAction: null,
      pendingActionSummary: "No pending actions."
    });

    expect(context.activeApp).toBe("image");
    expect(context.activeEntities).toEqual(["Recent image"]);
    expect(context.recentResults[0]).toContain("Visible text: Launch Notes");
    expect(context.communicationHints[0]).toContain("that screenshot");
  });

  it("includes profile, response preferences, and integration status in prompt context", () => {
    const context = buildConversationContext({
      latestUserMessage: "summarize this",
      userProfile: [
        "Timezone: America/New_York",
        "Connected integrations: Google (dhruv@gmail.com)",
        "Missing integrations: Asana, Notion"
      ],
      memoryEntries: [
        {
          key: "profile_preferred_name",
          value: {
            name: "Dhruv",
            source: "explicit"
          },
          updatedAt: new Date()
        },
        {
          key: "assistant_response_preferences",
          value: {
            verbosity: "concise",
            tone: "direct",
            format: "bullets",
            minimalFollowUps: true,
            humanLike: true,
            avoidEmDashes: true,
            avoidHyphenSeparators: true,
            style: "warm casual",
            personality: "calm operator"
          },
          updatedAt: new Date()
        }
      ],
      pendingAction: null,
      pendingActionSummary: "No pending actions."
    });

    const formatted = formatConversationContextForPrompt(context);

    expect(formatted).toContain("User profile:");
    expect(formatted).toContain("Preferred name: Dhruv");
    expect(formatted).toContain("Connected integrations: Google (dhruv@gmail.com)");
    expect(formatted).toContain(
      "Response preferences: concise, direct, bullets, minimal follow-ups, human-like, no em dashes, no casual dash separators, style: warm casual, personality: calm operator"
    );
  });
});
