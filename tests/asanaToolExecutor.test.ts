import { beforeEach, describe, expect, it, vi } from "vitest";

const listProjectsMock = vi.fn();
const listTeamsMock = vi.fn();
const listMyTasksMock = vi.fn();
const listProjectTasksMock = vi.fn();
const createTaskMock = vi.fn();
const updateTaskMock = vi.fn();
const deleteTaskMock = vi.fn();

vi.mock("../src/modules/asana/asanaService", () => ({
  AsanaService: vi.fn().mockImplementation(() => ({
    listProjects: listProjectsMock,
    listTeams: listTeamsMock,
    listMyTasks: listMyTasksMock,
    listProjectTasks: listProjectTasksMock,
    createTask: createTaskMock,
    updateTask: updateTaskMock,
    deleteTask: deleteTaskMock
  }))
}));

import { ToolExecutor } from "../src/modules/agent/toolExecutor";

describe("tool executor Asana flows", () => {
  beforeEach(() => {
    listProjectsMock.mockReset();
    listTeamsMock.mockReset();
    listMyTasksMock.mockReset();
    listProjectTasksMock.mockReset();
    createTaskMock.mockReset();
    updateTaskMock.mockReset();
    deleteTaskMock.mockReset();

    listProjectsMock.mockResolvedValue([
      {
        gid: "project_1",
        name: "Scanis",
        workspaceGid: "workspace_1",
        workspaceName: "My workspace",
        teamGid: "team_1",
        teamName: "Growth"
      }
    ]);

    listTeamsMock.mockResolvedValue([
      {
        gid: "team_1",
        name: "Growth",
        workspaceGid: "workspace_1",
        workspaceName: "My workspace"
      }
    ]);

    listMyTasksMock.mockResolvedValue([
      {
        gid: "task_1",
        name: "Ship Asana integration",
        completed: false,
        workspaceGid: "workspace_1",
        workspaceName: "Product",
        assigneeName: "Dhruv",
        projects: [{ gid: "project_1", name: "Scanis" }]
      }
    ]);

    listProjectTasksMock.mockResolvedValue([
      {
        gid: "task_1",
        name: "Ship Asana integration",
        completed: false,
        workspaceGid: "workspace_1",
        workspaceName: "Product",
        assigneeName: "Dhruv",
        projects: [{ gid: "project_1", name: "Scanis" }]
      }
    ]);

    createTaskMock.mockResolvedValue({
      gid: "task_1",
      name: "Ship Asana integration",
      completed: false,
      workspaceGid: "workspace_1",
      workspaceName: "Product",
      assigneeName: "Dhruv"
    });

    updateTaskMock.mockResolvedValue({
      gid: "task_1",
      name: "Ship Asana integration",
      completed: true,
      workspaceGid: "workspace_1",
      workspaceName: "Product",
      assigneeName: "Dhruv"
    });

    deleteTaskMock.mockResolvedValue({
      taskGid: "task_1",
      name: "Ship Asana integration",
      summary: "Deleted Asana task: Ship Asana integration"
    });
  });

  it("stores recent Asana project and team context when listing projects", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: { upsert: vi.fn(async () => undefined) }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
      { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
    );

    const result = await executor.executeToolCall(
      "asana_list_projects",
      { workspaceGid: "workspace_1" },
      {
        user: { id: "user_1", timezone: "America/New_York", whatsappPhone: "+15555550100" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "List my Asana projects"
      }
    );

    expect(result.ok).toBe(true);
    expect(listProjectsMock).toHaveBeenCalledWith("workspace_1", undefined);
    expect(prisma.memoryEntry.upsert.mock.calls.map((call: any[]) => call[0].create.key)).toEqual([
      "recent_asana_workspace",
      "recent_asana_projects",
      "recent_asana_teams"
    ]);
  });

  it("stores recent Asana task and project context when listing project tasks", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: { upsert: vi.fn(async () => undefined) }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
      { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
    );

    const result = await executor.executeToolCall(
      "asana_list_project_tasks",
      { projectGid: "project_1", dueOn: "2026-04-22" },
      {
        user: { id: "user_1", timezone: "America/New_York", whatsappPhone: "+15555550100" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "Show tasks in project Scanis due today"
      }
    );

    expect(result.ok).toBe(true);
    expect(listProjectTasksMock).toHaveBeenCalledWith({
      projectGid: "project_1",
      dueOn: "2026-04-22"
    });
    expect(prisma.memoryEntry.upsert.mock.calls.map((call: any[]) => call[0].create.key)).toEqual([
      "recent_asana_tasks",
      "recent_asana_projects",
      "recent_asana_workspace"
    ]);
  });

  it("stores recent Asana task context when creating a task", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: { upsert: vi.fn(async () => undefined) }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
      { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
    );

    const result = await executor.executeToolCall(
      "asana_create_task",
      { workspaceGid: "workspace_1", name: "Ship Asana integration" },
      {
        user: { id: "user_1", timezone: "America/New_York", whatsappPhone: "+15555550100" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "Create an Asana task to ship the integration"
      }
    );

    expect(result.ok).toBe(true);
    expect(createTaskMock).toHaveBeenCalledWith({
      workspaceGid: "workspace_1",
      name: "Ship Asana integration"
    });
    expect(prisma.memoryEntry.upsert).toHaveBeenCalledTimes(3);
  });

  it("drops conflicting due fields when the user asks for no due date", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: { upsert: vi.fn(async () => undefined) }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
      { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
    );

    const result = await executor.executeToolCall(
      "asana_create_task",
      {
        workspaceGid: "workspace_1",
        name: "Voice task",
        dueOn: "2026-04-23",
        dueAt: "2026-04-23T16:00:00.000Z"
      },
      {
        user: { id: "user_1", timezone: "America/New_York", whatsappPhone: "+15555550100" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "Make an Asana task with no due date"
      }
    );

    expect(result.ok).toBe(true);
    expect(createTaskMock).toHaveBeenCalledWith({
      workspaceGid: "workspace_1",
      name: "Voice task"
    });
  });

  it("stores recent Asana task context when updating a task", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: { upsert: vi.fn(async () => undefined) }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
      { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
    );

    const result = await executor.executeToolCall(
      "asana_update_task",
      { taskGid: "task_1", completed: true },
      {
        user: { id: "user_1", timezone: "America/New_York", whatsappPhone: "+15555550100" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "Mark that task done"
      }
    );

    expect(result.ok).toBe(true);
    expect(updateTaskMock).toHaveBeenCalledWith({
      taskGid: "task_1",
      completed: true
    });
    expect(prisma.memoryEntry.upsert).toHaveBeenCalledTimes(2);
  });

  it("clears both due fields when the user asks to remove the due date", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: { upsert: vi.fn(async () => undefined) }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
      { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
    );

    const result = await executor.executeToolCall(
      "asana_update_task",
      {
        taskGid: "task_1",
        dueOn: "2026-04-23",
        dueAt: "2026-04-23T16:00:00.000Z"
      },
      {
        user: { id: "user_1", timezone: "America/New_York", whatsappPhone: "+15555550100" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "Remove the due date from that task"
      }
    );

    expect(result.ok).toBe(true);
    expect(updateTaskMock).toHaveBeenCalledWith({
      taskGid: "task_1",
      dueOn: null,
      dueAt: null
    });
  });

  it("deletes a task directly when asked", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: { upsert: vi.fn(async () => undefined) }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
      { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
    );

    const result = await executor.executeToolCall(
      "asana_delete_task",
      { taskGid: "task_1" },
      {
        user: { id: "user_1", timezone: "America/New_York", whatsappPhone: "+15555550100" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "Delete that task"
      }
    );

    expect(result.ok).toBe(true);
    expect(deleteTaskMock).toHaveBeenCalledWith("task_1");
    expect(result.userMessage).toBe("Deleted Asana task: Ship Asana integration");
  });
});
