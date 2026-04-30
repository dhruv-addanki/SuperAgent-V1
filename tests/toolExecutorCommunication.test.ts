import { beforeEach, describe, expect, it, vi } from "vitest";

const listCalendarsMock = vi.fn();
const listEventsMock = vi.fn();
const searchFilesMock = vi.fn();
const readFileMetadataMock = vi.fn();
const deleteFileMock = vi.fn();
const readThreadMock = vi.fn();

vi.mock("../src/modules/google/calendarService", () => ({
  CalendarService: vi.fn().mockImplementation(() => ({
    listCalendars: listCalendarsMock,
    listEvents: listEventsMock
  }))
}));

vi.mock("../src/modules/google/driveService", () => ({
  DriveService: vi.fn().mockImplementation(() => ({
    searchFiles: searchFilesMock,
    readFileMetadata: readFileMetadataMock,
    deleteFile: deleteFileMock
  }))
}));

vi.mock("../src/modules/google/gmailService", () => ({
  GmailService: vi.fn().mockImplementation(() => ({
    readThread: readThreadMock
  }))
}));

import { ToolExecutor } from "../src/modules/agent/toolExecutor";

describe("tool executor communication context", () => {
  beforeEach(() => {
    listCalendarsMock.mockReset();
    listEventsMock.mockReset();
    searchFilesMock.mockReset();
    readFileMetadataMock.mockReset();
    deleteFileMock.mockReset();
    readThreadMock.mockReset();

    listCalendarsMock.mockResolvedValue([
      {
        id: "primary",
        summary: "Primary"
      }
    ]);

    listEventsMock.mockResolvedValue([
      {
        id: "event_1",
        title: "Weekly sync",
        calendarId: "primary",
        calendarSummary: "Primary",
        start: "2026-04-23T14:00:00.000Z"
      }
    ]);

    searchFilesMock.mockResolvedValue([
      {
        id: "file_1",
        name: "Launch Notes",
        mimeType: "application/vnd.google-apps.document"
      }
    ]);

    readFileMetadataMock.mockResolvedValue({
      id: "file_2",
      name: "Project Plan",
      mimeType: "application/pdf"
    });

    deleteFileMock.mockResolvedValue({
      fileId: "file_1",
      name: "Launch Notes",
      mimeType: "application/vnd.google-apps.document",
      summary: "Moved to trash: Launch Notes"
    });

    readThreadMock.mockResolvedValue([
      {
        id: "msg_1",
        threadId: "thread_1",
        subject: "Launch update",
        from: "founder@example.com",
        bodyText: "Please send the revised plan."
      }
    ]);
  });

  it("stores calendar list and event context for follow-up references", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: { upsert: vi.fn(async () => undefined) }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
      { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
    );

    await executor.executeToolCall(
      "calendar_list_calendars",
      {},
      {
        user: { id: "user_1", timezone: "America/New_York" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "list my calendars"
      }
    );

    await executor.executeToolCall(
      "calendar_list_events",
      {
        timeMin: "2026-04-23T00:00:00.000Z",
        timeMax: "2026-04-24T00:00:00.000Z"
      },
      {
        user: { id: "user_1", timezone: "America/New_York" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "what is on my calendar today"
      }
    );

    expect(prisma.memoryEntry.upsert.mock.calls.map((call: any[]) => call[0].create.key)).toEqual([
      "recent_calendars",
      "recent_calendar_events"
    ]);
  });

  it("filters excluded calendars from generic calendar event reads", async () => {
    listEventsMock.mockResolvedValue([
      {
        id: "event_school",
        title: "CS 3744",
        calendarId: "school",
        calendarSummary: "School",
        start: "2026-04-23T12:00:00.000Z"
      },
      {
        id: "event_kri",
        title: "PHYS 2720",
        calendarId: "kri_school",
        calendarSummary: "Kri School",
        start: "2026-04-23T20:00:00.000Z"
      }
    ]);
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: {
        findUnique: vi.fn(async ({ where }: any) =>
          where.userId_key.key === "calendar_exclusion_preferences"
            ? { value: { excludedCalendarNames: ["Kri School"] } }
            : null
        ),
        upsert: vi.fn(async () => undefined)
      }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
      { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
    );

    const result = await executor.executeToolCall(
      "calendar_list_events",
      {
        timeMin: "2026-04-23T00:00:00.000Z",
        timeMax: "2026-04-24T00:00:00.000Z"
      },
      {
        user: { id: "user_1", timezone: "America/New_York" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "what is on my calendar today"
      }
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      expect.objectContaining({
        id: "event_school",
        calendarSummary: "School"
      })
    ]);
    expect(prisma.memoryEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_key: { userId: "user_1", key: "recent_calendar_events" } },
        create: expect.objectContaining({
          value: [
            expect.objectContaining({
              eventId: "event_school",
              calendarSummary: "School"
            })
          ]
        })
      })
    );
  });

  it("clears recent calendar event memory when all events are excluded", async () => {
    listEventsMock.mockResolvedValue([
      {
        id: "event_kri",
        title: "PHYS 2720",
        calendarId: "kri_school",
        calendarSummary: "Kri School",
        start: "2026-04-23T20:00:00.000Z"
      }
    ]);
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: {
        findUnique: vi.fn(async ({ where }: any) =>
          where.userId_key.key === "calendar_exclusion_preferences"
            ? { value: { excludedCalendarNames: ["Kri School"] } }
            : null
        ),
        upsert: vi.fn(async () => undefined)
      }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
      { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
    );

    const result = await executor.executeToolCall(
      "calendar_list_events",
      {
        timeMin: "2026-04-23T00:00:00.000Z",
        timeMax: "2026-04-24T00:00:00.000Z"
      },
      {
        user: { id: "user_1", timezone: "America/New_York" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "what is on my calendar today"
      }
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([]);
    expect(prisma.memoryEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_key: { userId: "user_1", key: "recent_calendar_events" } },
        update: {
          value: [],
          confidence: 1
        }
      })
    );
  });

  it("filters excluded calendars by digest preference name variants", async () => {
    listEventsMock.mockResolvedValue([
      {
        id: "event_prof",
        title: "meeting with professor Chern",
        calendarId: "kri_school_calendar",
        calendarSummary: "KRI School Calendar",
        start: "2026-04-23T18:00:00.000Z"
      },
      {
        id: "event_general",
        title: "Kumon Zoom",
        calendarId: "primary",
        calendarSummary: "Primary",
        start: "2026-04-23T20:30:00.000Z"
      }
    ]);
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: {
        findUnique: vi.fn(async ({ where }: any) =>
          where.userId_key.key === "calendar_exclusion_preferences"
            ? { value: { excludedCalendarNames: ["kri school"] } }
            : null
        ),
        upsert: vi.fn(async () => undefined)
      }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
      { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
    );

    const result = await executor.executeToolCall(
      "calendar_list_events",
      {
        timeMin: "2026-04-23T00:00:00.000Z",
        timeMax: "2026-04-24T00:00:00.000Z"
      },
      {
        user: { id: "user_1", timezone: "America/New_York" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "run my morning digest"
      }
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      expect.objectContaining({
        id: "event_general",
        title: "Kumon Zoom"
      })
    ]);
  });

  it("stores recent Drive file context from search and metadata reads", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: { upsert: vi.fn(async () => undefined) }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
      { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
    );

    await executor.executeToolCall(
      "drive_search_files",
      { query: "launch notes" },
      {
        user: { id: "user_1", timezone: "America/New_York" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "find launch notes in Drive"
      }
    );

    await executor.executeToolCall(
      "drive_read_file_metadata",
      { fileId: "file_2" },
      {
        user: { id: "user_1", timezone: "America/New_York" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "open that file"
      }
    );

    expect(prisma.memoryEntry.upsert).toHaveBeenCalledTimes(3);
    expect(prisma.memoryEntry.upsert.mock.calls[0][0].create.key).toBe("recent_drive_files");
    expect(prisma.memoryEntry.upsert.mock.calls[1][0].create.key).toBe("recent_google_doc");
    expect(prisma.memoryEntry.upsert.mock.calls[1][0].create.value).toMatchObject({
      documentId: "file_1",
      title: "Launch Notes"
    });
    expect(prisma.memoryEntry.upsert.mock.calls[2][0].create.key).toBe("recent_drive_files");
  });

  it("clears the current Google Doc memory after deleting that Drive file", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: {
        findUnique: vi.fn(async () => ({
          key: "recent_google_doc",
          value: {
            documentId: "file_1",
            title: "Launch Notes"
          }
        })),
        delete: vi.fn(async () => undefined)
      }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
      { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
    );

    const result = await executor.executeToolCall(
      "drive_delete_file",
      { fileId: "file_1" },
      {
        user: { id: "user_1", timezone: "America/New_York" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "delete that doc"
      }
    );

    expect(result).toMatchObject({
      ok: true,
      userMessage: "Moved to trash: Launch Notes"
    });
    expect(prisma.memoryEntry.delete).toHaveBeenCalledWith({
      where: { userId_key: { userId: "user_1", key: "recent_google_doc" } }
    });
  });

  it("stores the most recently read Gmail thread for follow-up actions", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: { upsert: vi.fn(async () => undefined) }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
      { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
    );

    await executor.executeToolCall(
      "gmail_read_thread",
      { threadId: "thread_1" },
      {
        user: { id: "user_1", timezone: "America/New_York" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "read that email"
      }
    );

    expect(prisma.memoryEntry.upsert).toHaveBeenCalledOnce();
    expect(prisma.memoryEntry.upsert.mock.calls[0][0].create.key).toBe("recent_gmail_threads");
    expect(prisma.memoryEntry.upsert.mock.calls[0][0].create.value).toEqual([
      expect.objectContaining({
        threadId: "thread_1",
        subject: "Launch update",
        from: "founder@example.com"
      })
    ]);
  });
});
