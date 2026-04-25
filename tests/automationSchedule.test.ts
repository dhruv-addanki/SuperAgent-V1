import { describe, expect, it } from "vitest";
import {
  computeNextRunAt,
  formatScheduleLabel,
  normalizeAutomationSchedule
} from "../src/modules/automation/schedule";

describe("automation schedule utilities", () => {
  it("computes the next daily local-time run", () => {
    const schedule = { frequency: "daily", time: "08:00" };

    expect(
      computeNextRunAt(
        schedule,
        "America/New_York",
        new Date("2026-04-24T11:00:00.000Z")
      ).toISOString()
    ).toBe("2026-04-24T12:00:00.000Z");

    expect(
      computeNextRunAt(
        schedule,
        "America/New_York",
        new Date("2026-04-24T13:00:00.000Z")
      ).toISOString()
    ).toBe("2026-04-25T12:00:00.000Z");
  });

  it("skips weekends for weekday schedules", () => {
    expect(
      computeNextRunAt(
        { frequency: "weekdays", time: "08:00" },
        "America/New_York",
        new Date("2026-04-24T13:00:00.000Z")
      ).toISOString()
    ).toBe("2026-04-27T12:00:00.000Z");
  });

  it("normalizes weekly schedules and formats a user-facing label", () => {
    const schedule = normalizeAutomationSchedule({
      frequency: "weekly",
      time: "09:30",
      daysOfWeek: [3, 1, 1]
    });

    expect(schedule).toEqual({
      frequency: "weekly",
      time: "09:30",
      daysOfWeek: [1, 3]
    });
    expect(formatScheduleLabel(schedule, "America/New_York")).toBe(
      "Monday, Wednesday at 9:30 AM America/New_York"
    );
  });
});
