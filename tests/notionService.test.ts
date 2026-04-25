import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotionService } from "../src/modules/notion/notionService";

describe("Notion service", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("searches pages and filters unsupported result objects", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      results: [
        notionPage({ id: "page_1", title: "Scanis Plan" }),
        { object: "database", id: "db_1" }
      ]
    }));

    const service = new NotionService("access-token");
    const pages = await service.searchPages("scanis", 5);

    expect(pages).toEqual([
      expect.objectContaining({
        pageId: "page_1",
        title: "Scanis Plan",
        url: "https://notion.so/page_1"
      })
    ]);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer access-token");
    expect(init.headers["Notion-Version"]).toBe("2026-03-11");
    expect(JSON.parse(init.body)).toEqual(
      expect.objectContaining({
        query: "scanis",
        page_size: 5,
        filter: { property: "object", value: "page" }
      })
    );
  });

  it("reads page metadata and bounded child block text", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(notionPage({ id: "page_1", title: "Meeting Notes" })))
      .mockResolvedValueOnce(okResponse({
        has_more: false,
        results: [
          paragraphBlock("Summary line"),
          {
            object: "block",
            id: "todo_1",
            type: "to_do",
            has_children: false,
            to_do: {
              checked: true,
              rich_text: richText("Follow up")
            }
          }
        ]
      }));

    const service = new NotionService("access-token");
    const page = await service.readPage("page_1");

    expect(page.title).toBe("Meeting Notes");
    expect(page.text).toContain("Summary line");
    expect(page.text).toContain("- [x] Follow up");
  });

  it("creates a workspace page with converted blocks", async () => {
    fetchMock.mockResolvedValueOnce(okResponse(notionPage({ id: "page_1", title: "Meeting Notes" })));

    const service = new NotionService("access-token");
    const created = await service.createPage({
      title: "Meeting Notes",
      content: "# Header\n- Bullet\n1. Number\n- [ ] Todo"
    });

    expect(created.summary).toBe("Created Notion page: Meeting Notes");
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.parent).toEqual({ type: "workspace", workspace: true });
    expect(body.children.map((child: any) => child.type)).toEqual([
      "heading_1",
      "bulleted_list_item",
      "numbered_list_item",
      "to_do"
    ]);
  });

  it("appends content in chunks and retries one 429 response", async () => {
    const content = Array.from({ length: 101 }, (_, index) => `- item ${index + 1}`).join("\n");
    fetchMock
      .mockResolvedValueOnce(rateLimitResponse(0))
      .mockResolvedValueOnce(okResponse({ results: [] }))
      .mockResolvedValueOnce(okResponse({ results: [] }))
      .mockResolvedValueOnce(okResponse(notionPage({ id: "page_1", title: "Long Page" })));

    const service = new NotionService("access-token");
    const result = await service.appendToPage({ pageId: "page_1", content });

    expect(result.summary).toBe("Updated Notion page: Long Page");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).children).toHaveLength(100);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).children).toHaveLength(1);
  });

  it("updates page titles using the page title property name", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(notionPage({ id: "page_1", title: "Old Title" })))
      .mockResolvedValueOnce(okResponse(notionPage({ id: "page_1", title: "New Title" })));

    const service = new NotionService("access-token");
    const result = await service.updatePageTitle({
      pageId: "page_1",
      title: "New Title"
    });

    expect(result.summary).toBe("Renamed Notion page: New Title");
    expect(fetchMock.mock.calls[1][0]).toContain("/pages/page_1");
    const [, init] = fetchMock.mock.calls[1];
    const body = JSON.parse(init.body);
    expect(init.method).toBe("PATCH");
    expect(body.properties.Name.title[0].text.content).toBe("New Title");
  });

  it("maps page access failures to a user-facing error", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(403, "restricted"));

    const service = new NotionService("access-token");

    await expect(service.readPage("page_1")).rejects.toMatchObject({
      code: "NOTION_PAGE_ACCESS_FAILED"
    });
  });
});

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}

function rateLimitResponse(retryAfter: number): Response {
  return {
    ok: false,
    status: 429,
    headers: new Headers({ "Retry-After": String(retryAfter) }),
    json: async () => ({}),
    text: async () => JSON.stringify({ message: "rate limited" })
  } as Response;
}

function errorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: async () => ({ message }),
    text: async () => JSON.stringify({ message })
  } as Response;
}

function notionPage(input: { id: string; title: string }) {
  return {
    object: "page",
    id: input.id,
    url: `https://notion.so/${input.id}`,
    created_time: "2026-04-24T12:00:00.000Z",
    last_edited_time: "2026-04-24T12:30:00.000Z",
    parent: { type: "workspace", workspace: true },
    properties: {
      Name: {
        type: "title",
        title: richText(input.title)
      }
    }
  };
}

function paragraphBlock(text: string) {
  return {
    object: "block",
    id: "block_1",
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: richText(text)
    }
  };
}

function richText(text: string) {
  return [
    {
      type: "text",
      plain_text: text,
      text: { content: text }
    }
  ];
}
