import { beforeEach, describe, expect, it, vi } from "vitest";

const listWorkspacesMock = vi.fn();
const listProjectsMock = vi.fn();
const listTeamsMock = vi.fn();
const listUsersMock = vi.fn();
const listMyTasksMock = vi.fn();
const listProjectTasksMock = vi.fn();
const searchTasksMock = vi.fn();
const getTaskMock = vi.fn();
const createTaskMock = vi.fn();
const updateTaskMock = vi.fn();
const deleteTaskMock = vi.fn();

vi.mock("../src/modules/asana/asanaService", () => ({
  AsanaService: vi.fn().mockImplementation(() => ({
    listWorkspaces: listWorkspacesMock,
    listProjects: listProjectsMock,
    listTeams: listTeamsMock,
    listUsers: listUsersMock,
    listMyTasks: listMyTasksMock,
    listProjectTasks: listProjectTasksMock,
    searchTasks: searchTasksMock,
    getTask: getTaskMock,
    createTask: createTaskMock,
    updateTask: updateTaskMock,
    deleteTask: deleteTaskMock
  }))
}));

import { ToolExecutor } from "../src/modules/agent/toolExecutor";

function makePrisma(initialMemory: Record<string, unknown> = {}) {
  const memory = new Map(
    Object.entries(initialMemory).map(([key, value]) => [key, { value, confidence: 1 }])
  );

  return {
    auditLog: { create: vi.fn(async () => undefined) },
    memoryEntry: {
      findUnique: vi.fn(async ({ where }) => {
        const key = where.userId_key.key;
        return memory.get(key) ?? null;
      }),
      upsert: vi.fn(async ({ where, update, create }) => {
        const key = where.userId_key.key;
        memory.set(key, {
          value: update?.value ?? create.value,
          confidence: update?.confidence ?? create.confidence
        });
        return memory.get(key);
      })
    },
    pendingAction: {
      create: vi.fn(async ({ data }) => ({
        id: "pending_1",
        ...data
      })),
      update: vi.fn(async ({ data }) => data)
    }
  } as any;
}

function makeExecutor(prisma = makePrisma()) {
  return new ToolExecutor(
    prisma,
    { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
    { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
  );
}

function makeContext(latestUserMessage = "Use Asana") {
  return {
    user: { id: "user_1", timezone: "America/New_York", whatsappPhone: "+15555550100" } as any,
    conversation: { id: "conversation_1" } as any,
    latestUserMessage
  };
}

describe("tool executor Asana flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    listWorkspacesMock.mockResolvedValue([{ gid: "workspace_1", name: "Product" }]);
    listProjectsMock.mockResolvedValue([
      { gid: "project_1", name: "Scanis", workspaceGid: "workspace_1", workspaceName: "Product" },
      { gid: "project_2", name: "Content", workspaceGid: "workspace_1", workspaceName: "Product" }
    ]);
    listTeamsMock.mockResolvedValue([]);
    listUsersMock.mockResolvedValue([]);
    listMyTasksMock.mockResolvedValue([]);
    listProjectTasksMock.mockResolvedValue([
      {
        gid: "task_1",
        name: "Film demo",
        completed: false,
        workspaceGid: "workspace_1",
        workspaceName: "Product"
      }
    ]);
    searchTasksMock.mockResolvedValue([
      {
        gid: "task_1",
        name: "Ship Asana integration",
        completed: false,
        workspaceGid: "workspace_1",
        workspaceName: "Product"
      }
    ]);
    getTaskMock.mockResolvedValue({
      gid: "task_1",
      name: "Ship Asana integration",
      completed: false,
      workspaceGid: "workspace_1",
      workspaceName: "Product"
    });
    createTaskMock.mockResolvedValue({
      gid: "task_1",
      name: "Ship Asana integration",
      completed: false,
      workspaceGid: "workspace_1",
      workspaceName: "Product",
      assigneeName: "Dhruv"
    });
    updateTaskMock.mockImplementation(async (input) => ({
      gid: input.taskGid,
      name: "Ship Asana integration",
      completed: Boolean(input.completed),
      workspaceGid: "workspace_1",
      workspaceName: "Product",
      assigneeName: "Dhruv"
    }));
    deleteTaskMock.mockResolvedValue({
      taskGid: "task_1",
      name: "Ship Asana integration",
      summary: "Deleted Asana task: Ship Asana integration"
    });
  });

  it("stores recent Asana task context when creating a task", async () => {
    const prisma = makePrisma();
    const executor = makeExecutor(prisma);

    const result = await executor.executeToolCall(
      "asana_create_task",
      { workspaceGid: "workspace_1", name: "Ship Asana integration" },
      makeContext("Create an Asana task to ship the integration")
    );

    expect(result.ok).toBe(true);
    expect(createTaskMock).toHaveBeenCalledWith({
      workspaceGid: "workspace_1",
      name: "Ship Asana integration",
      projectGids: undefined
    });
    expect(prisma.memoryEntry.upsert).toHaveBeenCalledTimes(3);
  });

  it("stores recent Asana task context when updating a task", async () => {
    const prisma = makePrisma();
    const executor = makeExecutor(prisma);

    const result = await executor.executeToolCall(
      "asana_update_task",
      { taskGid: "task_1", completed: true },
      makeContext("Mark that task done")
    );

    expect(result.ok).toBe(true);
    expect(updateTaskMock).toHaveBeenCalledWith({
      taskGid: "task_1",
      name: undefined,
      notes: undefined,
      dueOn: undefined,
      dueAt: undefined,
      assigneeGid: undefined,
      completed: true
    });
    expect(prisma.memoryEntry.upsert).toHaveBeenCalledTimes(2);
  });

  it("deletes a task directly when asked", async () => {
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_delete_task",
      { taskGid: "task_1" },
      makeContext("Delete that task")
    );

    expect(result.ok).toBe(true);
    expect(deleteTaskMock).toHaveBeenCalledWith("task_1");
    expect(result.userMessage).toBe("Deleted Asana task: Ship Asana integration");
  });

  it("resolves a unique project name before listing project tasks", async () => {
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_list_project_tasks",
      { projectName: "Scanis", completed: false },
      makeContext("Show tasks in Scanis")
    );

    expect(result.ok).toBe(true);
    expect(listProjectsMock).toHaveBeenCalledWith("workspace_1");
    expect(listProjectTasksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectGid: "project_1",
        completed: false
      })
    );
  });

  it("returns a pick-list when project name resolution is ambiguous", async () => {
    listProjectsMock.mockResolvedValue([
      { gid: "project_1", name: "Scanis", workspaceGid: "workspace_1" },
      { gid: "project_2", name: "Scanis", workspaceGid: "workspace_1" }
    ]);
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_list_project_tasks",
      { projectName: "Scanis" },
      makeContext("Show tasks in Scanis")
    );

    expect(result.ok).toBe(false);
    expect(result.userMessage).toContain("multiple Asana projects");
    expect(listProjectTasksMock).not.toHaveBeenCalled();
  });

  it("treats a non-GID projectGid value as a project name for task creation", async () => {
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_create_task",
      { name: "Update wellness score", projectGids: ["Scanis"] },
      makeContext("Create this in Scanis")
    );

    expect(result.ok).toBe(true);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Update wellness score",
        projectGids: ["project_1"]
      })
    );
  });

  it("resolves a unique task name from recent Asana task memory for updates", async () => {
    const prisma = makePrisma({
      recent_asana_tasks: [
        {
          taskGid: "task_42",
          name: "Apply Brand Deals",
          completed: false,
          workspaceGid: "workspace_1"
        }
      ]
    });
    const executor = makeExecutor(prisma);

    const result = await executor.executeToolCall(
      "asana_update_task",
      { taskName: "Apply Brand Deals", completed: true },
      makeContext("Complete Apply Brand Deals")
    );

    expect(result.ok).toBe(true);
    expect(updateTaskMock).toHaveBeenCalledWith(expect.objectContaining({ taskGid: "task_42" }));
    expect(searchTasksMock).not.toHaveBeenCalled();
  });

  it("returns a pick-list when task name resolution is ambiguous", async () => {
    searchTasksMock.mockResolvedValue([
      { gid: "task_1", name: "Apply Brand Deals", completed: false },
      { gid: "task_2", name: "Apply Chase Bonus", completed: false }
    ]);
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_delete_task",
      { taskName: "Apply" },
      makeContext("Delete Apply")
    );

    expect(result.ok).toBe(false);
    expect(result.userMessage).toContain("multiple Asana tasks");
    expect(deleteTaskMock).not.toHaveBeenCalled();
  });

  it("stages bulk completion behind confirmation", async () => {
    const prisma = makePrisma();
    const executor = makeExecutor(prisma);

    const result = await executor.executeToolCall(
      "asana_bulk_update_tasks",
      { taskGids: ["task_1", "task_2"], completed: true },
      makeContext("Complete all listed tasks")
    );

    expect(result.ok).toBe(true);
    expect(result.approvalRequired).toBe(true);
    expect(result.userMessage).toContain("Complete 2 Asana tasks");
    expect(prisma.pendingAction.create).toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it("executes confirmed bulk completion sequentially", async () => {
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_bulk_update_tasks",
      { taskGids: ["task_1", "task_2"], completed: true },
      makeContext("yes"),
      { force: true }
    );

    expect(result.ok).toBe(true);
    expect(updateTaskMock).toHaveBeenCalledTimes(2);
    expect(updateTaskMock).toHaveBeenNthCalledWith(1, { taskGid: "task_1", completed: true });
    expect(updateTaskMock).toHaveBeenNthCalledWith(2, { taskGid: "task_2", completed: true });
    expect(result.userMessage).toBe("Completed 2 Asana tasks.");
  });
});
