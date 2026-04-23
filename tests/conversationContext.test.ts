import { describe, expect, it } from "vitest";
import {
  buildConversationContext,
  formatConversationContextForPrompt
} from "../src/modules/agent/conversationContext";

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
    expect(context.activeEntities).toEqual([
      "Google Doc: Strategy Notes (documentId: doc_123)"
    ]);
    expect(context.recentResults).toEqual(["Current Google Doc: Strategy Notes."]);
    expect(context.communicationHints).toContain(
      "If the user says same doc, current doc, that doc, or append to it, use the stored Google Doc above."
    );
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
});
