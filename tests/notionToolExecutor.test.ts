import { beforeEach, describe, expect, it, vi } from "vitest";

const searchPagesMock = vi.fn();
const readPageMock = vi.fn();
const createPageMock = vi.fn();
const appendToPageMock = vi.fn();
const updatePageTitleMock = vi.fn();

vi.mock("../src/modules/notion/notionService", () => ({
  NotionService: vi.fn().mockImplementation(() => ({
    searchPages: searchPagesMock,
    readPage: readPageMock,
    createPage: createPageMock,
    appendToPage: appendToPageMock,
    updatePageTitle: updatePageTitleMock
  }))
}));

import { ToolExecutor } from "../src/modules/agent/toolExecutor";

describe("tool executor Notion tools", () => {
  beforeEach(() => {
    searchPagesMock.mockReset();
    readPageMock.mockReset();
    createPageMock.mockReset();
    appendToPageMock.mockReset();
    updatePageTitleMock.mockReset();
    searchPagesMock.mockResolvedValue([
      {
        pageId: "page_1",
        title: "Scanis Plan",
        url: "https://notion.so/page_1",
        lastEditedTime: "2026-04-24T12:00:00.000Z"
      }
    ]);
    readPageMock.mockResolvedValue({
      pageId: "page_1",
      title: "Scanis Plan",
      url: "https://notion.so/page_1",
      text: "Plan text",
      blocks: ["Plan text"]
    });
    createPageMock.mockResolvedValue({
      pageId: "page_2",
      title: "Meeting Notes",
      url: "https://notion.so/page_2",
      summary: "Created Notion page: Meeting Notes"
    });
    appendToPageMock.mockResolvedValue({
      pageId: "page_1",
      title: "Scanis Plan",
      url: "https://notion.so/page_1",
      summary: "Updated Notion page: Scanis Plan"
    });
    updatePageTitleMock.mockResolvedValue({
      pageId: "page_1",
      title: "Renamed Plan",
      url: "https://notion.so/page_1",
      summary: "Renamed Notion page: Renamed Plan"
    });
  });

  it("stores recent Notion search results for follow-up actions", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: { upsert: vi.fn(async () => undefined) }
    } as any;
    const executor = createExecutor(prisma);

    const result = await executor.executeToolCall(
      "notion_search_pages",
      { query: "Scanis", limit: 5 },
      context("find my Notion page about Scanis")
    );

    expect(result.ok).toBe(true);
    expect(searchPagesMock).toHaveBeenCalledWith("Scanis", 5);
    expect(prisma.memoryEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_key: { userId: "user_1", key: "recent_notion_pages" } }
      })
    );
    expect(prisma.memoryEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_key: { userId: "user_1", key: "recent_notion_page" } }
      })
    );
  });

  it("creates Notion pages and logs the write", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: { upsert: vi.fn(async () => undefined) }
    } as any;
    const executor = createExecutor(prisma);

    const result = await executor.executeToolCall(
      "notion_create_page",
      { title: "Meeting Notes", content: "Summary" },
      context("create a Notion page called Meeting Notes with this summary")
    );

    expect(result.ok).toBe(true);
    expect(result.userMessage).toContain("Created: Meeting Notes");
    expect(createPageMock).toHaveBeenCalledWith({
      title: "Meeting Notes",
      content: "Summary"
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: "notion_create_page",
          status: "executed"
        })
      })
    );
  });

  it("appends to Notion pages and remembers the edited page", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: { upsert: vi.fn(async () => undefined) }
    } as any;
    const executor = createExecutor(prisma);

    const result = await executor.executeToolCall(
      "notion_append_page",
      { pageId: "page_1", content: "Follow up" },
      context("append this to that Notion page")
    );

    expect(result.ok).toBe(true);
    expect(result.userMessage).toContain("Updated: Scanis Plan");
    expect(appendToPageMock).toHaveBeenCalledWith({
      pageId: "page_1",
      content: "Follow up"
    });
    expect(prisma.memoryEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_key: { userId: "user_1", key: "recent_notion_page" } }
      })
    );
  });

  it("renames Notion pages and logs the write", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: { upsert: vi.fn(async () => undefined) }
    } as any;
    const executor = createExecutor(prisma);

    const result = await executor.executeToolCall(
      "notion_update_page_title",
      { pageId: "page_1", title: "Renamed Plan" },
      context("rename that Notion page to Renamed Plan")
    );

    expect(result.ok).toBe(true);
    expect(result.userMessage).toContain("Renamed: Renamed Plan");
    expect(updatePageTitleMock).toHaveBeenCalledWith({
      pageId: "page_1",
      title: "Renamed Plan"
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: "notion_update_page_title",
          status: "executed"
        })
      })
    );
  });
});

function createExecutor(prisma: any): ToolExecutor {
  return new ToolExecutor(
    prisma,
    { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
    { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any,
    { getAccessTokenForUser: vi.fn(async () => "notion-token") } as any
  );
}

function context(latestUserMessage: string) {
  return {
    user: { id: "user_1", whatsappPhone: "+15555550100", timezone: "America/New_York" } as any,
    conversation: { id: "conversation_1" } as any,
    latestUserMessage
  };
}
