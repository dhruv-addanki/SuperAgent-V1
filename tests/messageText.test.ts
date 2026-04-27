import { describe, expect, it } from "vitest";
import { normalizeAssistantMessageForUser } from "../src/lib/messageText";

describe("assistant message text", () => {
  it("removes casual dash separators from user-facing replies", () => {
    expect(normalizeAssistantMessageForUser("Booked — 3:00 PM")).toBe("Booked, 3:00 PM");
    expect(normalizeAssistantMessageForUser("Done—updated")).toBe("Done, updated");
    expect(normalizeAssistantMessageForUser("Thanks - ready when you are.")).toBe(
      "Thanks, ready when you are."
    );
    expect(normalizeAssistantMessageForUser("Thanks ---- ready when you are.")).toBe(
      "Thanks, ready when you are."
    );
  });
});
