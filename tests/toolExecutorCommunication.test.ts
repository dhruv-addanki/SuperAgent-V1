import { beforeEach, describe, expect, it, vi } from "vitest";

const listCalendarsMock = vi.fn();
const listEventsMock = vi.fn();
const searchFilesMock = vi.fn();
const readFileMetadataMock = vi.fn();
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
    readFileMetadata: readFileMetadataMock
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

    expect(prisma.memoryEntry.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.memoryEntry.upsert.mock.calls[0][0].create.key).toBe("recent_drive_files");
    expect(prisma.memoryEntry.upsert.mock.calls[1][0].create.key).toBe("recent_drive_files");
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
