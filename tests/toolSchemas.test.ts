import { describe, expect, it } from "vitest";
import { buildToolDefinitions, toolInputSchemas } from "../src/schemas/toolSchemas";

describe("tool schemas", () => {
  it("validates Gmail draft inputs", () => {
    expect(() =>
      toolInputSchemas.gmail_create_draft.parse({
        to: "not-an-email",
        subject: "Hello",
        body: "Body"
      })
    ).toThrow();

    expect(
      toolInputSchemas.gmail_create_draft.parse({
        to: "brad@example.com",
        subject: "Hello",
        body: "Body"
      }).to
    ).toBe("brad@example.com");
  });

  it("omits write tools in read-only mode", () => {
    const tools = buildToolDefinitions(true);
    expect(tools.some((tool) => tool.name === "gmail_create_draft")).toBe(false);
    expect(tools.some((tool) => tool.name === "gmail_trash_thread")).toBe(false);
    expect(tools.some((tool) => tool.name === "drive_delete_file")).toBe(false);
    expect(tools.some((tool) => tool.name === "asana_create_task")).toBe(false);
    expect(tools.some((tool) => tool.name === "asana_update_task")).toBe(false);
    expect(tools.some((tool) => tool.name === "asana_delete_task")).toBe(false);
    expect(tools.some((tool) => tool.name === "notion_create_page")).toBe(false);
    expect(tools.some((tool) => tool.name === "notion_append_page")).toBe(false);
    expect(tools.some((tool) => tool.name === "web_search")).toBe(true);
    expect(tools.some((tool) => tool.name === "calendar_list_events")).toBe(true);
    expect(tools.some((tool) => tool.name === "docs_read_document")).toBe(true);
    expect(tools.some((tool) => tool.name === "asana_list_my_tasks")).toBe(true);
    expect(tools.some((tool) => tool.name === "asana_list_teams")).toBe(true);
    expect(tools.some((tool) => tool.name === "asana_list_project_tasks")).toBe(true);
    expect(tools.some((tool) => tool.name === "notion_search_pages")).toBe(true);
    expect(tools.some((tool) => tool.name === "notion_read_page")).toBe(true);
  });

  it("validates Asana task inputs", () => {
    expect(() =>
      toolInputSchemas.asana_update_task.parse({
        taskGid: "123",
        dueOn: "tomorrow"
      })
    ).toThrow();

    expect(
      toolInputSchemas.asana_update_task.parse({
        taskGid: "123",
        dueOn: null,
        completed: true
      }).completed
    ).toBe(true);

    expect(
      toolInputSchemas.asana_delete_task.parse({
        taskGid: "123"
      }).taskGid
    ).toBe("123");

    expect(
      toolInputSchemas.asana_list_project_tasks.parse({
        projectGid: "project_1",
        dueOn: "2026-04-22",
        limit: 5
      }).dueOn
    ).toBe("2026-04-22");
  });

  it("validates Notion page inputs", () => {
    expect(() =>
      toolInputSchemas.notion_search_pages.parse({
        query: "meeting",
        limit: 100
      })
    ).toThrow();

    expect(
      toolInputSchemas.notion_create_page.parse({
        title: "Meeting Notes",
        content: "Summary",
        parentPageId: "page_1"
      }).title
    ).toBe("Meeting Notes");

    expect(
      toolInputSchemas.notion_append_page.parse({
        pageId: "page_1",
        content: "Follow up"
      }).pageId
    ).toBe("page_1");
  });
});
