import { describe, expect, it } from "vitest";
import {
  asanaTaskDueDate,
  formatAsanaTaskOverview,
  matchGenericAsanaMyTasksRequest
} from "../src/modules/agent/asanaReadShortcut";

describe("asana read shortcut", () => {
  it("matches generic personal due-today and due-tomorrow requests", () => {
    expect(matchGenericAsanaMyTasksRequest("show my asana tasks due today")).toBe("today");
    expect(matchGenericAsanaMyTasksRequest("check my asana tasks due tomorrow")).toBe("tomorrow");
    expect(matchGenericAsanaMyTasksRequest("show tasks in project Scanis due today")).toBeNull();
  });

  it("computes due dates in the user's timezone", () => {
    expect(
      asanaTaskDueDate("today", "America/New_York", new Date("2026-04-22T03:30:00.000Z"))
    ).toBe("2026-04-21");
    expect(
      asanaTaskDueDate("tomorrow", "America/New_York", new Date("2026-04-22T03:30:00.000Z"))
    ).toBe("2026-04-22");
  });

  it("formats task overviews consistently", () => {
    expect(formatAsanaTaskOverview([], "today")).toBe("You have no Asana tasks due today.");
    expect(
      formatAsanaTaskOverview(
        [
          { gid: "task_1", name: "test task 1", completed: false },
          { gid: "task_2", name: "test task 2", completed: false }
        ],
        "today"
      )
    ).toBe("Your Asana tasks due today:\n\n1. test task 1\n2. test task 2");
  });
});
