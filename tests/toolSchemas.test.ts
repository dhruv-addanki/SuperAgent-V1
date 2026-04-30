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
    expect(tools.some((tool) => tool.name === "asana_bulk_update_tasks")).toBe(false);
    expect(tools.some((tool) => tool.name === "web_search")).toBe(true);
    expect(tools.some((tool) => tool.name === "calendar_list_events")).toBe(true);
    expect(tools.some((tool) => tool.name === "docs_read_document")).toBe(true);
    expect(tools.some((tool) => tool.name === "asana_list_my_tasks")).toBe(true);
  });

  it("validates Asana task update inputs", () => {
    expect(() =>
      toolInputSchemas.asana_update_task.parse({
        taskGid: "123",
        taskName: "Duplicate target",
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
        taskName: "Apply Brand Deals"
      }).taskName
    ).toBe("Apply Brand Deals");

    expect(() =>
      toolInputSchemas.asana_delete_task.parse({
        taskGid: "123",
        taskName: "Apply Brand Deals"
      })
    ).toThrow();
  });

  it("validates Asana project name and ID resolution inputs", () => {
    expect(() =>
      toolInputSchemas.asana_list_my_tasks.parse({
        projectGid: "Scanis"
      })
    ).toThrow();

    expect(
      toolInputSchemas.asana_list_project_tasks.parse({
        projectName: "Scanis",
        completed: false
      }).projectName
    ).toBe("Scanis");

    expect(() =>
      toolInputSchemas.asana_list_project_tasks.parse({
        projectGid: "123",
        projectName: "Scanis"
      })
    ).toThrow();

    expect(() => toolInputSchemas.asana_list_project_tasks.parse({ completed: false })).toThrow();

    expect(
      toolInputSchemas.asana_create_task.parse({
        name: "Update wellness score",
        projectNames: ["Scanis"]
      }).projectNames
    ).toEqual(["Scanis"]);

    expect(
      toolInputSchemas.asana_search_tasks.parse({
        text: "wellness score",
        projectName: "Scanis"
      }).taskGid
    ).toBeUndefined();
  });

  it("validates guarded Asana bulk completion inputs", () => {
    expect(
      toolInputSchemas.asana_bulk_update_tasks.parse({
        taskGids: ["task_1"],
        completed: true
      }).completed
    ).toBe(true);

    expect(() =>
      toolInputSchemas.asana_bulk_update_tasks.parse({
        taskGids: ["task_1"],
        completed: false
      })
    ).toThrow();

    expect(() =>
      toolInputSchemas.asana_bulk_update_tasks.parse({
        taskGids: Array.from({ length: 26 }, (_, index) => `task_${index + 1}`),
        completed: true
      })
    ).toThrow();
  });
});
