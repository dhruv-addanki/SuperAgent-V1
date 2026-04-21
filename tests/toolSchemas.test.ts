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
    expect(tools.some((tool) => tool.name === "calendar_list_events")).toBe(true);
    expect(tools.some((tool) => tool.name === "docs_read_document")).toBe(true);
  });
});
