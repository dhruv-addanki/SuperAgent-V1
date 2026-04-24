import { describe, expect, it } from "vitest";
import {
  calendarOverviewWindow,
  formatCalendarOverview,
  matchCalendarAllCalendarsFollowUpRequest,
  matchGenericCalendarOverviewRequest
} from "../src/modules/agent/calendarReadShortcut";

describe("calendar read shortcut", () => {
  it("matches generic all-calendar overview requests", () => {
    expect(matchGenericCalendarOverviewRequest("What's on my calendar today?")).toBe("today");
    expect(matchGenericCalendarOverviewRequest("What's on my cal today")).toBe("today");
    expect(matchGenericCalendarOverviewRequest("Check all my calendars tomorrow")).toBe(
      "tomorrow"
    );
    expect(matchGenericCalendarOverviewRequest("Check my calendar")).toBe("today");
    expect(matchGenericCalendarOverviewRequest("What's on my meetings calendar today?")).toBe(
      null
    );
  });

  it("does not steal calendar write requests", () => {
    expect(
      matchGenericCalendarOverviewRequest(
        "Why is NVDA stock up today and put it in my calendar to check it and make a trade decision at 3 today"
      )
    ).toBeNull();
    expect(matchGenericCalendarOverviewRequest("Add dentist to my calendar at 3 today")).toBeNull();
  });

  it("builds a timezone-correct day window and formats an all-calendar overview", () => {
    const window = calendarOverviewWindow(
      "today",
      "America/New_York",
      new Date("2026-04-21T05:00:00.000Z")
    );

    expect(window.label).toBe("today");
    expect(window.timeMin).toBe("2026-04-21T04:00:00.000Z");
    expect(window.timeMax).toBe("2026-04-22T04:00:00.000Z");

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

  it("matches positive follow-ups to an all-calendar check", () => {
    expect(
      matchCalendarAllCalendarsFollowUpRequest("Check them all yes", [
        {
          role: "assistant",
          content: "Nothing matched on that calendar today.\n\nWant me to check all calendars for today instead?"
        }
      ])
    ).toBe("today");
  });
});
