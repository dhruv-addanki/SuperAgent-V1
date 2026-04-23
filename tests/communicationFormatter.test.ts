import { describe, expect, it } from "vitest";
import { formatToolResultForModel } from "../src/modules/agent/communicationFormatter";

describe("communication formatter", () => {
  it("marks empty Asana task lists as empty results with a useful next step", () => {
    const formatted = formatToolResultForModel("asana_list_my_tasks", {
      ok: true,
      data: []
    });

    expect(formatted).toMatchObject({
      ok: true,
      communication: {
        app: "asana",
        outcome: "empty",
        summary: "No Asana tasks matched that request.",
        nextStep: "You can ask for another project, date, or keyword."
      }
    });
  });

  it("adds reference entities and next-step guidance for non-empty read results", () => {
    const formatted = formatToolResultForModel("calendar_list_events", {
      ok: true,
      data: [
        {
          id: "event_1",
          title: "Weekly sync",
          calendarId: "primary"
        }
      ]
    });

    expect(formatted).toMatchObject({
      ok: true,
      communication: {
        app: "calendar",
        outcome: "read_result",
        summary: "Found 1 calendar event in that window.",
        nextStep: "You can ask me to move, cancel, or focus on one event.",
        referenceEntities: [
          {
            kind: "calendar_event",
            id: "event_1",
            name: "Weekly sync",
            secondaryId: "primary"
          }
        ]
      }
    });
  });

  it("uses direct write messages as human summaries", () => {
    const formatted = formatToolResultForModel("drive_delete_file", {
      ok: true,
      data: {
        fileId: "file_1",
        name: "Old Notes"
      },
      userMessage: "Moved to trash: Old Notes"
    });

    expect(formatted).toMatchObject({
      ok: true,
      communication: {
        app: "drive",
        outcome: "write_complete",
        summary: "Moved to trash: Old Notes",
        nextStep: "You can ask me to search Drive again if you want to clean up more files."
      }
    });
  });

  it("preserves the underlying data payload for the model", () => {
    const formatted = formatToolResultForModel("gmail_search_threads", {
      ok: true,
      data: [
        {
          threadId: "thread_1",
          subject: "Launch update"
        }
      ]
    });

    expect(formatted).toMatchObject({
      data: [
        {
          threadId: "thread_1",
          subject: "Launch update"
        }
      ],
      communication: {
        referenceEntities: [
          {
            kind: "gmail_thread",
            id: "thread_1",
            name: "Launch update"
          }
        ]
      }
    });
  });
});
