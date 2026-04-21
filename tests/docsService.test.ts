import { describe, expect, it } from "vitest";
import { extractDocumentText } from "../src/modules/google/docsService";

describe("docs service", () => {
  it("extracts plain text from paragraphs and tables", () => {
    const text = extractDocumentText([
      {
        paragraph: {
          elements: [{ textRun: { content: "Intro line\n" } }]
        }
      },
      {
        table: {
          tableRows: [
            {
              tableCells: [
                {
                  content: [
                    {
                      paragraph: {
                        elements: [{ textRun: { content: "Cell A\n" } }]
                      }
                    }
                  ]
                },
                {
                  content: [
                    {
                      paragraph: {
                        elements: [{ textRun: { content: "Cell B\n" } }]
                      }
                    }
                  ]
                }
              ]
            }
          ]
        }
      }
    ]);

    expect(text).toContain("Intro line");
    expect(text).toContain("Cell A");
    expect(text).toContain("Cell B");
  });

  it("preserves section-like append text cleanly", () => {
    const text = extractDocumentText([
      {
        paragraph: {
          elements: [{ textRun: { content: "Existing content\n" } }]
        }
      },
      {
        paragraph: {
          elements: [{ textRun: { content: "Next Steps for Expansion\n• Contact intelligence\n" } }]
        }
      }
    ]);

    expect(text).toContain("Existing content");
    expect(text).toContain("Next Steps for Expansion");
    expect(text).toContain("• Contact intelligence");
  });
});
