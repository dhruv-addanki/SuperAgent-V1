import { AutomationStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  formatAutomationList,
  type AutomationSummary
} from "../src/modules/automation/automationService";

const dueAutomation: AutomationSummary = {
  id: "automation_1",
  name: "Morning brief",
  status: AutomationStatus.ACTIVE,
  scheduleLabel: "Every day at 8:00 AM America/New_York",
  timezone: "America/New_York",
  nextRunAt: new Date("2026-04-26T12:00:00.000Z"),
  lastRunAt: null
};

describe("automation formatting", () => {
  it("flags overdue automations when the production runner is disabled", () => {
    const message = formatAutomationList([dueAutomation], "America/New_York", {
      now: new Date("2026-04-26T13:00:00.000Z"),
      runnerEnabled: false
    });

    expect(message).toContain("Overdue: automation runner is disabled.");
  });

  it("flags overdue automations that are waiting for the runner", () => {
    const message = formatAutomationList([dueAutomation], "America/New_York", {
      now: new Date("2026-04-26T13:00:00.000Z"),
      runnerEnabled: true
    });

    expect(message).toContain("Overdue: waiting for runner.");
  });
});
