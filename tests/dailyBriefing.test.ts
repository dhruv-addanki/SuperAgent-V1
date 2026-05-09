import { describe, expect, it } from "vitest";
import {
  buildDailyBriefingSnapshot,
  formatDailyBriefingSnapshotForPrompt
} from "../src/modules/automation/dailyBriefing";

describe("daily briefing intelligence", () => {
  it("suppresses event-level digest filters and all-day task-like calendar items", () => {
    const snapshot = buildDailyBriefingSnapshot({
      timezone: "America/New_York",
      memoryEntries: [
        {
          key: "digest_filter_rules",
          value: {
            rules: [
              {
                domain: "calendar",
                behavior: "exclude_from_digest",
                scope: "scheduled_digest",
                match: { eventTitle: "PHYS 3340 final exam" },
                reason: "User excluded school finals"
              }
            ]
          },
          updatedAt: new Date("2026-05-08T12:00:00.000Z")
        }
      ],
      calendarResult: {
        ok: true,
        data: [
          {
            id: "final",
            title: "PHYS 3340 FINAL EXAM",
            start: "2026-05-08T18:00:00.000Z",
            end: "2026-05-08T21:00:00.000Z",
            calendarSummary: "School"
          },
          {
            id: "router",
            title: "due date router test",
            start: "2026-05-08",
            end: "2026-05-09",
            calendarSummary: "Primary"
          },
          {
            id: "interview",
            title: "Jessica Clair interview",
            start: "2026-05-08T15:00:00.000Z",
            end: "2026-05-08T15:30:00.000Z",
            calendarSummary: "Primary"
          }
        ]
      }
    });

    expect(snapshot.selectedFacts.map((fact) => fact.title)).toEqual(["Jessica Clair interview"]);
    expect(snapshot.suppressedFacts.map((fact) => fact.title)).toEqual([
      "PHYS 3340 FINAL EXAM",
      "due date router test"
    ]);
    expect(formatDailyBriefingSnapshotForPrompt(snapshot)).not.toContain("PHYS 3340");
  });

  it("prioritizes unread actionable email and downranks promotional read threads", () => {
    const snapshot = buildDailyBriefingSnapshot({
      timezone: "America/New_York",
      memoryEntries: [],
      gmailResult: {
        ok: true,
        data: [
          {
            threadId: "promo",
            subject: "AICamp summit newsletter",
            from: "news@example.com",
            labelIds: ["CATEGORY_PROMOTIONS"],
            unread: false
          },
          {
            threadId: "interview",
            subject: "Addanki Interview with Jessica Clair",
            from: "Jessica Clair <jessica@example.gov>",
            labelIds: ["INBOX", "UNREAD"],
            unread: true,
            snippet: "ZoomGov invite attached"
          }
        ]
      }
    });

    expect(snapshot.selectedFacts[0]?.title).toBe("Addanki Interview with Jessica Clair");
    expect(snapshot.selectedFacts[0]?.reasons).toContain("unread");
    expect(snapshot.selectedFacts[0]?.reasons).toContain("actionable");
  });

  it("uses the Asana priority profile and downranks test tasks", () => {
    const snapshot = buildDailyBriefingSnapshot({
      timezone: "America/New_York",
      now: new Date("2026-05-08T12:00:00.000Z"),
      memoryEntries: [
        {
          key: "asana_priority_profile",
          value: {
            categoryWeights: {
              school: 40,
              test: -40
            }
          },
          updatedAt: new Date("2026-05-08T12:00:00.000Z")
        }
      ],
      asanaResult: {
        ok: true,
        data: [
          {
            gid: "task_test",
            name: "due date router test",
            completed: false,
            dueOn: "2026-05-08"
          },
          {
            gid: "task_school",
            name: "Systems Class Ex5 Due",
            completed: false,
            dueOn: "2026-05-07",
            projects: [{ gid: "school", name: "School" }]
          }
        ]
      }
    });

    expect(snapshot.selectedFacts[0]?.title).toBe("Systems Class Ex5 Due");
    expect(snapshot.selectedFacts[0]?.reasons).toContain("school-task");
  });
});
