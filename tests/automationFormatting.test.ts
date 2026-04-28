import { AutomationStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  formatAutomationList,
  type AutomationSummary
} from "../src/modules/automation/automationService";
import {
  buildScheduledAutomationInstructions,
  filterAutomationContextMemoryEntries,
  formatAutomationDigest
} from "../src/modules/automation/automationScheduler";

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

  it("formats command-center digests without redundant headings or weak retry tails", () => {
    const message = formatAutomationDigest(
      "Morning email, calendar, and Asana digest",
      [
        "Morning digest:",
        "",
        "At a glance:",
        "Heavy class day, two conflicts, and one due-soon task.",
        "Schedule:",
        "9:00 AM DS 2002",
        "9:30 AM Urology Appt",
        "10:00 AM PHYS 3420",
        "12:00 PM PHYS 3340",
        "4:00 PM CS 3604",
        "4:30 PM office hours",
        "5:30 PM CS 3214",
        "Focus plan:",
        "Morning: resolve the scheduling conflict.",
        "Midday: pick one school deliverable.",
        "Evening: pick one Scanis task.",
        "Watchouts:",
        "9:00 to 10:30 has overlapping events.",
        "4:00 to 6:45 has overlapping events.",
        "You can ask me to:",
        "\"Move office hours to another slot\"",
        "\"Create a calendar block for the Chase call\"",
        "",
        "If you want, I can retry the missing parts now."
      ].join("\n")
    );

    expect(message).toContain("At a glance:");
    expect(message).toContain("Watchouts:");
    expect(message).toContain("You can ask me to:");
    expect(message).toContain("\"Move office hours to another slot\"");
    expect(message).not.toContain("Morning digest:");
    expect(message).not.toContain("retry the missing parts");
    expect(message).not.toMatch(/[—–]/);
    expect(message).not.toMatch(/ [–—-] /);
    expect(message.split("\n").length).toBeLessThanOrEqual(20);
  });

  it("keeps quiet day digests compact and does not add urgency", () => {
    const message = formatAutomationDigest(
      "Morning brief",
      [
        "At a glance:",
        "Quiet morning. No calendar conflicts and no urgent tasks found.",
        "Schedule:",
        "No events until noon.",
        "Focus plan:",
        "Use the open block for one important task."
      ].join("\n")
    );

    expect(message).toContain("Quiet morning.");
    expect(message).not.toContain("You can ask me to:");
    expect(message.split("\n").length).toBeLessThanOrEqual(8);
  });

  it("keeps source failures brief while preserving successful sections", () => {
    const message = formatAutomationDigest(
      "Morning brief",
      [
        "At a glance:",
        "Email and Asana loaded, but Calendar is unavailable.",
        "Schedule:",
        "Calendar unavailable. I couldn't reach Google Calendar right now.",
        "Focus plan:",
        "Handle the due-soon Asana task first.",
        "You can ask me to:",
        "\"Run the calendar check again\""
      ].join("\n")
    );

    expect(message).toContain("Email and Asana loaded");
    expect(message).toContain("Calendar unavailable");
    expect(message).toContain("\"Run the calendar check again\"");
  });

  it("removes empty command-center section labels", () => {
    const message = formatAutomationDigest(
      "Morning email, calendar, and Asana digest",
      [
        "*At a glance:* Light class schedule today, with one admin priority.",
        "",
        "*Schedule:*",
        "• 8:00 AM to 9:15 AM: CS 3744",
        "",
        "*Focus plan:*",
        "• First block: handle the Treasury onboarding email.",
        "",
        "*Watchouts:*",
        "*You can ask me to:*"
      ].join("\n")
    );

    expect(message).toContain("*At a glance:*");
    expect(message).toContain("*Schedule:*");
    expect(message).toContain("*Focus plan:*");
    expect(message).not.toContain("*Watchouts:*");
    expect(message).not.toContain("*You can ask me to:*");
  });

  it("documents the command-center scheduled automation prompt rules", () => {
    const instructions = buildScheduledAutomationInstructions("Base prompt");

    expect(instructions).toContain("compact command center");
    expect(instructions).toContain("Target 10 to 14 WhatsApp-friendly lines");
    expect(instructions).toContain("At a glance, Schedule, Focus plan, Watchouts, You can ask me to");
    expect(instructions).toContain("Never output an empty section label");
    expect(instructions).toContain("1 to 3 exact reply commands");
    expect(instructions).toContain("at least one quoted command");
    expect(instructions).toContain("trust the preloaded data");
    expect(instructions).toContain("Scheduled runs stay read-only");
    expect(instructions).toContain("Good candidates");
  });

  it("removes stale recent-result memory from automation prompt context", () => {
    const entries = filterAutomationContextMemoryEntries([
      {
        key: "recent_calendar_events",
        value: [{ title: "PHYS 2720", calendarSummary: "Kri School" }]
      },
      {
        key: "calendar_exclusion_preferences",
        value: { excludedCalendarNames: ["Kri School"] }
      },
      {
        key: "assistant_response_preferences",
        value: { verbosity: "concise" }
      }
    ]);

    expect(entries).toEqual([
      {
        key: "calendar_exclusion_preferences",
        value: { excludedCalendarNames: ["Kri School"] }
      },
      {
        key: "assistant_response_preferences",
        value: { verbosity: "concise" }
      }
    ]);
  });
});
