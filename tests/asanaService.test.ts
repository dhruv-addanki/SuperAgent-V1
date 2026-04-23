import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsanaService } from "../src/modules/asana/asanaService";

describe("asana service", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists workspaces and sorts them by name", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { gid: "2", name: "Zeta" },
          { gid: "1", name: "Alpha", is_organization: true }
        ]
      })
    });

    const service = new AsanaService("token");
    const workspaces = await service.listWorkspaces();

    expect(workspaces).toEqual([
      { gid: "1", name: "Alpha", isOrganization: true },
      { gid: "2", name: "Zeta", isOrganization: undefined }
    ]);
  });

  it("aggregates workspace projects with team projects and dedupes them", async () => {
    fetchMock.mockImplementation(async (url: URL | string) => {
      const value = url.toString();

      if (value.includes("/workspaces/workspace_1/projects") && value.includes("offset=page_2")) {
        return {
          ok: true,
          json: async () => ({
            data: [{ gid: "project_2", name: "Scanis" }]
          })
        };
      }

      if (value.includes("/workspaces/workspace_1/projects")) {
        return {
          ok: true,
          json: async () => ({
            data: [{ gid: "project_1", name: "AI Learning" }],
            next_page: { offset: "page_2" }
          })
        };
      }

      if (value.includes("/workspaces/workspace_1/teams")) {
        return {
          ok: true,
          json: async () => ({
            data: [{ gid: "team_1", name: "Growth", organization: { gid: "workspace_1" } }]
          })
        };
      }

      if (value.includes("/teams/team_1/projects")) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { gid: "project_2", name: "Scanis" },
              { gid: "project_3", name: "Content" }
            ]
          })
        };
      }

      throw new Error(`Unexpected URL ${value}`);
    });

    const projects = await new AsanaService("token").listProjects("workspace_1");

    expect(projects).toEqual([
      {
        gid: "project_1",
        name: "AI Learning",
        workspaceGid: undefined,
        workspaceName: undefined,
        teamGid: undefined,
        teamName: undefined,
        archived: undefined
      },
      {
        gid: "project_3",
        name: "Content",
        workspaceGid: "workspace_1",
        workspaceName: undefined,
        teamGid: "team_1",
        teamName: "Growth",
        archived: undefined
      },
      {
        gid: "project_2",
        name: "Scanis",
        workspaceGid: "workspace_1",
        workspaceName: undefined,
        teamGid: "team_1",
        teamName: "Growth",
        archived: undefined
      }
    ]);
  });

  it("lists my tasks through the user task list endpoint and filters by completion and due date", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { gid: "utl_1" }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { gid: "task_1", name: "Due soon", completed: false, due_on: "2026-04-21" },
            { gid: "task_2", name: "Done", completed: true, due_on: "2026-04-20" }
          ]
        })
      });

    const service = new AsanaService("token");
    const tasks = await service.listMyTasks({
      workspaceGid: "workspace_1",
      completed: false,
      dueBefore: "2026-04-21"
    });

    expect(fetchMock.mock.calls[0][0].toString()).toContain("/users/me/user_task_list");
    expect(fetchMock.mock.calls[1][0].toString()).toContain("/user_task_lists/utl_1/tasks");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ gid: "task_1", name: "Due soon" });
  });

  it("falls back to a workspace task query when My Tasks is unavailable", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ errors: [{ message: "user task list unavailable" }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { gid: "task_1", name: "Today", completed: false, due_on: "2026-04-22" },
            { gid: "task_2", name: "Later", completed: false, due_on: "2026-04-23" }
          ]
        })
      });

    const tasks = await new AsanaService("token").listMyTasks({
      workspaceGid: "workspace_1",
      dueOn: "2026-04-22",
      completed: false
    });

    expect(fetchMock.mock.calls[0][0].toString()).toContain("/users/me/user_task_list");
    expect(fetchMock.mock.calls[1][0].toString()).toContain("/tasks?");
    expect(tasks).toEqual([
      expect.objectContaining({
        gid: "task_1",
        name: "Today",
        dueOn: "2026-04-22"
      })
    ]);
  });

  it("lists project tasks with due date filtering", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { gid: "task_1", name: "Today", completed: false, due_on: "2026-04-22" },
          { gid: "task_2", name: "Tomorrow", completed: false, due_on: "2026-04-23" }
        ]
      })
    });

    const tasks = await new AsanaService("token").listProjectTasks({
      projectGid: "project_1",
      dueOn: "2026-04-22"
    });

    expect(fetchMock.mock.calls[0][0].toString()).toContain("/projects/project_1/tasks");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ gid: "task_1", name: "Today" });
  });

  it("sorts latest completed project tasks by completed_at", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            gid: "task_1",
            name: "Earlier complete",
            completed: true,
            completed_at: "2026-04-23T12:00:00.000Z"
          },
          {
            gid: "task_2",
            name: "Latest complete",
            completed: true,
            completed_at: "2026-04-23T19:00:00.000Z"
          }
        ]
      })
    });

    const tasks = await new AsanaService("token").listProjectTasks({
      projectGid: "project_1",
      completed: true,
      sortBy: "completedAt",
      sortDirection: "desc",
      limit: 1
    });

    expect(tasks).toEqual([
      expect.objectContaining({
        gid: "task_2",
        name: "Latest complete",
        completedAt: "2026-04-23T19:00:00.000Z"
      })
    ]);
  });

  it("maps expired auth failures", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ errors: [{ message: "expired" }] })
    });

    await expect(new AsanaService("token").listWorkspaces()).rejects.toMatchObject({
      code: "ASANA_AUTH_EXPIRED"
    });
  });

  it("maps premium search failures", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ errors: [{ message: "Payment Required" }] })
    });

    await expect(
      new AsanaService("token").searchTasks({ workspaceGid: "1", text: "bug" })
    ).rejects.toMatchObject({
      code: "ASANA_SEARCH_PREMIUM_REQUIRED"
    });
  });

  it("maps forbidden responses", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ errors: [{ message: "Forbidden" }] })
    });

    await expect(new AsanaService("token").getTask("task_1")).rejects.toMatchObject({
      code: "ASANA_FORBIDDEN"
    });
  });

  it("maps missing resources", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ errors: [{ message: "Not Found" }] })
    });

    await expect(new AsanaService("token").getTask("task_1")).rejects.toMatchObject({
      code: "ASANA_NOT_FOUND"
    });
  });

  it("maps rate limits", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ errors: [{ message: "Rate limit" }] })
    });

    await expect(new AsanaService("token").listUsers("workspace_1")).rejects.toMatchObject({
      code: "ASANA_RATE_LIMITED"
    });
  });

  it("deletes a task after reading its name", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { gid: "task_1", name: "Old task" }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({})
      });

    const result = await new AsanaService("token").deleteTask("task_1");

    expect(fetchMock.mock.calls[0][0].toString()).toContain("/tasks/task_1");
    expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
    expect(result).toEqual({
      taskGid: "task_1",
      name: "Old task",
      summary: "Deleted Asana task: Old task"
    });
  });
});
