import { UserFacingError } from "../../lib/errors";
import { NOTION_API_BASE_URL, NOTION_API_VERSION } from "./notionOAuthClient";
import type { NotionPageContent, NotionPageSummary, NotionWriteSummary } from "./notionTypes";

const MAX_BLOCKS_RETURNED = 120;
const MAX_TEXT_RETURNED = 12_000;
const MAX_BLOCK_DEPTH = 2;
const MAX_CHILDREN_PER_REQUEST = 100;
const MAX_RICH_TEXT_CHARS = 2000;

interface RequestOptions extends RequestInit {
  retryOnRateLimit?: boolean;
}

export class NotionService {
  constructor(private readonly accessToken: string) {}

  async searchPages(query: string, limit = 10): Promise<NotionPageSummary[]> {
    const data = await this.request<any>("/search", {
      method: "POST",
      body: JSON.stringify({
        query,
        page_size: Math.min(Math.max(limit, 1), 25),
        filter: {
          property: "object",
          value: "page"
        }
      })
    });

    return ((data.results as any[]) ?? [])
      .filter((item) => item?.object === "page")
      .map((page) => normalizePage(page))
      .filter((page): page is NotionPageSummary => Boolean(page));
  }

  async readPage(pageId: string): Promise<NotionPageContent> {
    const page = await this.request<any>(`/pages/${encodeURIComponent(pageId)}`);
    const summary = normalizePage(page) ?? {
      pageId,
      title: "Untitled"
    };
    const blocks = await this.retrieveBlockText(pageId);
    const text = trimText(blocks.join("\n"));

    return {
      ...summary,
      text,
      blocks
    };
  }

  async createPage(input: {
    title: string;
    content: string;
    parentPageId?: string;
  }): Promise<NotionWriteSummary> {
    const blocks = textToBlocks(input.content);
    const firstChunk = blocks.slice(0, MAX_CHILDREN_PER_REQUEST);
    const remaining = blocks.slice(MAX_CHILDREN_PER_REQUEST);

    let created: any;
    try {
      created = await this.request<any>("/pages", {
        method: "POST",
        body: JSON.stringify({
          parent: input.parentPageId
            ? { page_id: input.parentPageId }
            : { type: "workspace", workspace: true },
          properties: {
            title: {
              title: richText(input.title)
            }
          },
          children: firstChunk
        })
      });
    } catch (error) {
      if (!input.parentPageId && error instanceof UserFacingError && error.code === "NOTION_API_ERROR") {
        throw new UserFacingError(
          "Notion parent page required",
          "NOTION_PARENT_PAGE_REQUIRED",
          "I need a parent Notion page for that. Search for the parent page first, then ask me to create it there."
        );
      }
      throw error;
    }

    const summary = normalizePage(created) ?? {
      pageId: created.id as string,
      title: input.title,
      url: created.url as string | undefined
    };

    if (remaining.length) {
      await this.appendBlocks(summary.pageId, remaining);
    }

    return {
      ...summary,
      summary: `Created Notion page: ${summary.title}`
    };
  }

  async appendToPage(input: { pageId: string; content: string }): Promise<NotionWriteSummary> {
    const blocks = textToBlocks(input.content);
    await this.appendBlocks(input.pageId, blocks);
    const page = await this.request<any>(`/pages/${encodeURIComponent(input.pageId)}`);
    const summary = normalizePage(page) ?? {
      pageId: input.pageId,
      title: "Untitled"
    };

    return {
      ...summary,
      summary: `Updated Notion page: ${summary.title}`
    };
  }

  async updatePageTitle(input: { pageId: string; title: string }): Promise<NotionWriteSummary> {
    const currentPage = await this.request<any>(`/pages/${encodeURIComponent(input.pageId)}`);
    const titlePropertyName = titlePropertyKey(currentPage) ?? "title";
    const page = await this.request<any>(`/pages/${encodeURIComponent(input.pageId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          [titlePropertyName]: {
            title: richText(input.title)
          }
        }
      })
    });

    const summary = normalizePage(page) ?? {
      pageId: input.pageId,
      title: input.title,
      url: page?.url as string | undefined
    };

    return {
      ...summary,
      summary: `Renamed Notion page: ${summary.title}`
    };
  }

  private async appendBlocks(pageId: string, blocks: Array<Record<string, unknown>>): Promise<void> {
    const chunks = chunk(blocks, MAX_CHILDREN_PER_REQUEST);
    for (const children of chunks) {
      await this.request(`/blocks/${encodeURIComponent(pageId)}/children`, {
        method: "PATCH",
        body: JSON.stringify({ children })
      });
    }
  }

  private async retrieveBlockText(blockId: string): Promise<string[]> {
    const blocks: string[] = [];
    await this.collectBlockText(blockId, 0, blocks);
    return blocks;
  }

  private async collectBlockText(blockId: string, depth: number, output: string[]): Promise<void> {
    let cursor: string | undefined;

    do {
      if (output.length >= MAX_BLOCKS_RETURNED) return;
      const params = new URLSearchParams({ page_size: "100" });
      if (cursor) params.set("start_cursor", cursor);
      const data = await this.request<any>(
        `/blocks/${encodeURIComponent(blockId)}/children?${params.toString()}`
      );

      for (const block of (data.results as any[]) ?? []) {
        if (output.length >= MAX_BLOCKS_RETURNED) return;
        const text = blockToText(block, depth);
        if (text) output.push(text);
        if (block?.has_children && depth < MAX_BLOCK_DEPTH) {
          await this.collectBlockText(block.id, depth + 1, output);
        }
      }

      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
  }

  private async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const retryOnRateLimit = options.retryOnRateLimit ?? true;
    const response = await fetch(`${NOTION_API_BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_API_VERSION,
        ...(options.headers ?? {})
      }
    });

    if (response.status === 429 && retryOnRateLimit) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? "1");
      await sleep(Math.max(retryAfter, 0) * 1000);
      return this.request<T>(path, { ...options, retryOnRateLimit: false });
    }

    if (!response.ok) {
      throw await notionError(response);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

function normalizePage(page: any): NotionPageSummary | null {
  if (!page?.id) return null;

  return {
    pageId: page.id,
    title: pageTitle(page),
    url: typeof page.url === "string" ? page.url : undefined,
    createdTime: typeof page.created_time === "string" ? page.created_time : undefined,
    lastEditedTime: typeof page.last_edited_time === "string" ? page.last_edited_time : undefined,
    parentType: typeof page.parent?.type === "string" ? page.parent.type : undefined,
    parentId: page.parent ? parentId(page.parent) : undefined
  };
}

function pageTitle(page: any): string {
  if (Array.isArray(page.title)) {
    const title = richTextPlain(page.title).trim();
    if (title) return title;
  }

  const properties = page.properties && typeof page.properties === "object" ? page.properties : {};
  for (const property of Object.values(properties) as any[]) {
    if (property?.type === "title" && Array.isArray(property.title)) {
      const title = richTextPlain(property.title).trim();
      if (title) return title;
    }
  }

  return "Untitled";
}

function titlePropertyKey(page: any): string | null {
  const properties = page.properties && typeof page.properties === "object" ? page.properties : {};
  for (const [key, property] of Object.entries(properties) as Array<[string, any]>) {
    if (property?.type === "title") return key;
  }
  return null;
}

function parentId(parent: any): string | undefined {
  const type = parent.type;
  if (type === "page_id") return parent.page_id;
  if (type === "database_id") return parent.database_id;
  if (type === "data_source_id") return parent.data_source_id;
  if (type === "workspace") return "workspace";
  return undefined;
}

function blockToText(block: any, depth: number): string | null {
  const type = block?.type;
  const value = type ? block[type] : null;
  const text = richTextPlain(value?.rich_text).trim();
  if (!text) return null;

  const indent = "  ".repeat(depth);
  if (type === "heading_1") return `${indent}# ${text}`;
  if (type === "heading_2") return `${indent}## ${text}`;
  if (type === "heading_3") return `${indent}### ${text}`;
  if (type === "bulleted_list_item") return `${indent}- ${text}`;
  if (type === "numbered_list_item") return `${indent}1. ${text}`;
  if (type === "to_do") return `${indent}- [${value?.checked ? "x" : " "}] ${text}`;
  if (type === "quote") return `${indent}> ${text}`;
  if (type === "code") return `${indent}${text}`;
  return `${indent}${text}`;
}

function textToBlocks(content: string): Array<Record<string, unknown>> {
  const lines = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (!lines.length) {
    throw new UserFacingError(
      "Empty Notion content",
      "NOTION_EMPTY_CONTENT",
      "I need some content to add to Notion."
    );
  }

  return lines.map(lineToBlock);
}

function lineToBlock(line: string): Record<string, unknown> {
  const trimmed = line.trim();
  const todo = trimmed.match(/^[-*]\s+\[( |x|X)\]\s+(.+)$/);
  if (todo) {
    return block("to_do", todo[2]!, { checked: todo[1]!.toLowerCase() === "x" });
  }

  const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
  if (heading) {
    const type = heading[1]!.length === 1 ? "heading_1" : heading[1]!.length === 2 ? "heading_2" : "heading_3";
    return block(type, heading[2]!);
  }

  const bullet = trimmed.match(/^[-*]\s+(.+)$/);
  if (bullet) return block("bulleted_list_item", bullet[1]!);

  const numbered = trimmed.match(/^\d+\.\s+(.+)$/);
  if (numbered) return block("numbered_list_item", numbered[1]!);

  return block("paragraph", trimmed);
}

function block(type: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: "block",
    type,
    [type]: {
      rich_text: richText(text),
      ...extra
    }
  };
}

function richText(text: string): Array<Record<string, unknown>> {
  return text.match(new RegExp(`.{1,${MAX_RICH_TEXT_CHARS}}`, "gs"))?.map((chunk) => ({
    type: "text",
    text: {
      content: chunk
    }
  })) ?? [];
}

function richTextPlain(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) =>
      typeof item?.plain_text === "string"
        ? item.plain_text
        : typeof item?.text?.content === "string"
          ? item.text.content
          : ""
    )
    .join("");
}

function trimText(text: string): string {
  if (text.length <= MAX_TEXT_RETURNED) return text;
  return `${text.slice(0, MAX_TEXT_RETURNED - 20).trimEnd()}\n\n[truncated]`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function notionError(response: Response): Promise<UserFacingError> {
  const text = await response.text();
  let message = text;
  try {
    const body = JSON.parse(text) as { message?: string };
    message = body.message ?? text;
  } catch {
    // Keep the plain text body.
  }

  if (response.status === 401) {
    return new UserFacingError(
      "Notion authentication failed",
      "NOTION_AUTH_FAILED",
      "Reconnect your Notion account and try again."
    );
  }

  if (response.status === 403 || response.status === 404) {
    return new UserFacingError(
      "Notion page access failed",
      "NOTION_PAGE_ACCESS_FAILED",
      "Notion has not granted access to that page. Reconnect Notion and select the page, or share it with the integration."
    );
  }

  if (response.status === 429) {
    return new UserFacingError(
      "Notion rate limited",
      "NOTION_RATE_LIMITED",
      "Notion is rate limiting requests right now. Try again in a minute."
    );
  }

  return new UserFacingError(
    `Notion API request failed: ${message}`,
    "NOTION_API_ERROR",
    "I couldn't complete that Notion request right now. Try again in a moment."
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
