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
