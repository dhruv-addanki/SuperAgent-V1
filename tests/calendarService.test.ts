import { describe, expect, it } from "vitest";
import { mergeCalendarEventCollections } from "../src/modules/google/calendarService";

describe("calendar service helpers", () => {
  it("merges, sorts, and limits events across calendars", () => {
    const events = mergeCalendarEventCollections(
      [
        [
          {
            id: "evt_2",
            title: "Standup",
            start: "2026-04-21T14:00:00.000Z",
            end: "2026-04-21T14:30:00.000Z",
            calendarId: "meetings",
            calendarSummary: "Meetings"
          }
        ],
        [
          {
            id: "evt_1",
            title: "Breakfast",
            start: "2026-04-21T12:00:00.000Z",
            end: "2026-04-21T12:30:00.000Z",
            calendarId: "general",
            calendarSummary: "General"
          }
        ]
      ],
      10
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: "evt_1",
      calendarId: "general",
      calendarSummary: "General"
    });
    expect(events[1]).toMatchObject({
      id: "evt_2",
      calendarId: "meetings",
      calendarSummary: "Meetings"
    });
  });
});
