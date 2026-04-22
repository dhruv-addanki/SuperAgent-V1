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
    expect(tools.some((tool) => tool.name === "web_search")).toBe(true);
    expect(tools.some((tool) => tool.name === "calendar_list_events")).toBe(true);
    expect(tools.some((tool) => tool.name === "docs_read_document")).toBe(true);
    expect(tools.some((tool) => tool.name === "asana_list_my_tasks")).toBe(true);
  });

  it("validates Asana task update inputs", () => {
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
  });
});
