import { beforeEach, describe, expect, it, vi } from "vitest";

const createTaskMock = vi.fn();
const updateTaskMock = vi.fn();
const deleteTaskMock = vi.fn();

vi.mock("../src/modules/asana/asanaService", () => ({
  AsanaService: vi.fn().mockImplementation(() => ({
    createTask: createTaskMock,
    updateTask: updateTaskMock,
    deleteTask: deleteTaskMock
  }))
}));

import { ToolExecutor } from "../src/modules/agent/toolExecutor";

describe("tool executor Asana flows", () => {
  beforeEach(() => {
    createTaskMock.mockReset();
    updateTaskMock.mockReset();
    deleteTaskMock.mockReset();

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
