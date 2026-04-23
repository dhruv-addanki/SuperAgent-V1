import { describe, expect, it } from "vitest";
import {
  asanaTaskDueDate,
  formatAsanaTodayAndLatestOpenReply,
  formatLatestAsanaTaskReply,
  formatScopedAsanaTaskList,
  formatAsanaTaskOverview,
  matchAmbiguousAsanaBulkCompleteRequest,
  matchAsanaDueTodayAndLatestOpenRequest,
  matchAsanaLatestTaskShortcut,
  matchAsanaListShortcut,
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
    expect(formatAsanaTaskOverview([], "today")).toBe(
      "I don't see any open Asana tasks due today."
    );
    expect(
      formatAsanaTaskOverview(
        [
          { gid: "task_1", name: "test task 1", completed: false },
          { gid: "task_2", name: "test task 2", completed: false }
        ],
        "today"
      )
    ).toBe("Here are the open Asana tasks due today:\n\n1. test task 1\n2. test task 2");
  });

  it("matches compound today-and-latest-open requests", () => {
    const match = matchAsanaDueTodayAndLatestOpenRequest(
      "What are my most important Asana tasks today and what's the last incomplete task I had and when",
      [{ role: "assistant", content: "Earlier Asana reply" }],
      [],
      "America/New_York",
      new Date("2026-04-23T15:00:00.000Z")
    );

    expect(match).toEqual({
      dueOn: "2026-04-23",
      label: "today"
    });
  });

  it("matches Asana date-list shortcuts across all projects and follow-up dates", () => {
    const recentAsanaContext = [
      {
        key: "recent_asana_tasks",
        value: [{ taskGid: "task_1", name: "test 1" }],
        updatedAt: new Date("2026-04-23T15:00:00.000Z")
      }
    ];

    expect(
      matchAsanaListShortcut(
        "Check my tasks from April 11th across all projects",
        [],
        recentAsanaContext as any,
        "America/New_York",
        new Date("2026-04-23T15:00:00.000Z")
      )
    ).toMatchObject({
      scope: "my_tasks",
      dueOn: "2026-04-11",
      label: "due on Apr 11"
    });

    expect(
      matchAsanaListShortcut(
        "Ok what about before yesterday",
        [{ role: "assistant", content: "Latest open Asana task: test 2" }],
        recentAsanaContext as any,
        "America/New_York",
        new Date("2026-04-23T15:00:00.000Z")
      )
    ).toMatchObject({
      scope: "my_tasks",
      dueBefore: "2026-04-21",
      label: "due before yesterday"
    });
  });

  it("matches latest-task shortcuts with recent project context", () => {
    const match = matchAsanaLatestTaskShortcut(
      "Check my latest completed task in Scanis",
      [{ role: "assistant", content: "Your Asana projects: Scanis" }],
      [
        {
          key: "recent_asana_projects",
          value: [{ projectGid: "project_1", name: "Scanis" }],
          updatedAt: new Date("2026-04-23T15:00:00.000Z")
        }
      ] as any
    );

    expect(match).toMatchObject({
      scope: "project",
      project: {
        projectGid: "project_1",
        name: "Scanis"
      },
      completed: true,
      sortBy: "completedAt",
      sortDirection: "desc"
    });
  });

  it("detects ambiguous bulk-complete requests from recent task context", () => {
    const match = matchAmbiguousAsanaBulkCompleteRequest(
      "Mark all tasks as complete",
      [
        {
          key: "recent_asana_tasks",
          value: [
            { taskGid: "task_1", name: "test 1", projectName: "Scanis" },
            { taskGid: "task_2", name: "test 2", projectName: "Scanis" }
          ],
          updatedAt: new Date("2026-04-23T15:00:00.000Z")
        }
      ] as any
    );

    expect(match).toEqual({
      taskCount: 2,
      projectName: "Scanis"
    });
  });

  it("formats richer list and latest-task replies", () => {
    expect(
      formatScopedAsanaTaskList(
        [
          {
            gid: "task_1",
            name: "test task 1",
            completed: false,
            workspaceName: "My workspace",
            projects: [{ gid: "project_1", name: "Scanis" }]
          }
        ],
        {
          label: "due on Apr 11",
          emptyLabel: "None"
        }
      )
    ).toContain("test task 1 (Scanis)");

    expect(
      formatLatestAsanaTaskReply(
        {
          gid: "task_2",
          name: "test 2",
          completed: true,
          completedAt: "2026-04-23T19:16:00.000Z",
          createdAt: "2026-04-22T23:26:00.000Z"
        },
        {
          label: "latest completed",
          timezone: "America/New_York",
          scopeName: "Scanis",
          completed: true
        }
      )
    ).toContain("Latest completed Asana task in Scanis:");

    expect(
      formatAsanaTodayAndLatestOpenReply(
        [{ gid: "task_1", name: "test task 1", completed: false }],
        {
          gid: "task_2",
          name: "test 2",
          completed: false,
          modifiedAt: "2026-04-23T19:16:00.000Z"
        },
        "America/New_York",
        "today"
      )
    ).toContain("Latest open Asana task:");
  });
});
