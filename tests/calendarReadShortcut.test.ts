import { describe, expect, it } from "vitest";
import {
  calendarOverviewWindow,
  formatCalendarOverview,
  matchGenericCalendarOverviewRequest
} from "../src/modules/agent/calendarReadShortcut";

describe("calendar read shortcut", () => {
  it("matches generic all-calendar overview requests", () => {
    expect(matchGenericCalendarOverviewRequest("What's on my calendar today?")).toBe("today");
    expect(matchGenericCalendarOverviewRequest("What's on my cal today")).toBe("today");
    expect(matchGenericCalendarOverviewRequest("Check all my calendars tomorrow")).toBe(
      "tomorrow"
    );
    expect(matchGenericCalendarOverviewRequest("What's on my meetings calendar today?")).toBe(
      null
    );
  });

  it("builds a day window and formats an all-calendar overview", () => {
    const window = calendarOverviewWindow(
      "today",
      "America/New_York",
      new Date("2026-04-21T05:00:00.000Z")
    );

    expect(window.label).toBe("today");
    expect(window.timeMin).not.toBe(window.timeMax);

    const message = formatCalendarOverview(
      [
        {
          title: "Breakfast",
          start: "2026-04-21T12:00:00.000Z",
          end: "2026-04-21T12:30:00.000Z",
          calendarSummary: "General"
        },
        {
          title: "All day note",
          start: "2026-04-21",
          end: "2026-04-22",
          calendarSummary: "Personal"
        }
      ],
      "America/New_York",
      "today"
    );

    expect(message).toContain("Across all calendars today:");
    expect(message).toContain("Breakfast (General)");
    expect(message).toContain("All day — All day note (Personal)");
  });
});
