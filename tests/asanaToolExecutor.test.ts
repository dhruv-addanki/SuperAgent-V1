import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listWorkspacesMock = vi.fn();
const listProjectsMock = vi.fn();
const listTeamsMock = vi.fn();
const listUsersMock = vi.fn();
const listMyTasksMock = vi.fn();
const listProjectTasksMock = vi.fn();
const searchTasksMock = vi.fn();
const getTaskMock = vi.fn();
const createTaskMock = vi.fn();
const addTaskToProjectMock = vi.fn();
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
    addTaskToProject: addTaskToProjectMock,
    updateTask: updateTaskMock,
    deleteTask: deleteTaskMock
  }))
}));

import { ToolExecutor } from "../src/modules/agent/toolExecutor";
import { UserFacingError } from "../src/lib/errors";
import { env } from "../src/config/env";

const originalAsanaPatFallbackToken = env.ASANA_PAT_FALLBACK_TOKEN;

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
    asanaAccount: {
      findUnique: vi.fn(async () => ({ asanaUserGid: "user_asana_1" }))
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
      {
        gid: "project_1",
        name: "Scanis",
        workspaceGid: "workspace_1",
        workspaceName: "My workspace",
        teamGid: "team_1",
        teamName: "Growth"
      },
      {
        gid: "project_2",
        name: "Content",
        workspaceGid: "workspace_1",
        workspaceName: "My workspace"
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

    listUsersMock.mockResolvedValue([]);
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
    addTaskToProjectMock.mockResolvedValue(undefined);
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

  afterEach(() => {
    (env as any).ASANA_PAT_FALLBACK_TOKEN = originalAsanaPatFallbackToken;
    vi.useRealTimers();
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
    const rememberedKeys = prisma.memoryEntry.upsert.mock.calls.map(
      (call: any[]) => call[0].create.key
    );
    expect(rememberedKeys).toContain("recent_asana_workspace");
    expect(rememberedKeys).toContain("recent_asana_projects");
    expect(rememberedKeys).toContain("recent_asana_teams");
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
      "recent_asana_workspace",
      "last_visible_asana_task_list"
    ]);
  });

  it("returns a pick-list style error for unresolved project names without listing tasks", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      memoryEntry: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
      }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn(async () => ({})) } as any,
      { getAccessTokenForUser: vi.fn(async () => "asana-token") } as any
    );

    const result = await executor.executeToolCall(
      "asana_list_project_tasks",
      { projectName: "My Tasks", dueOn: "2026-04-22" },
      {
        user: { id: "user_1", timezone: "America/New_York", whatsappPhone: "+15555550100" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "make an Asana plan"
      }
    );

    expect(result.ok).toBe(false);
    expect(result.userMessage).toContain('project named "My Tasks"');
    expect(listProjectTasksMock).not.toHaveBeenCalled();
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
      projectGids: undefined,
      assigneeGid: "user_asana_1"
    });
    expect(prisma.memoryEntry.upsert).toHaveBeenCalledTimes(3);
  });

  it("defaults project task creation to the connected Asana user", async () => {
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_create_task",
      { name: "Update wellness score", projectGids: ["Scanis"], assigneeGid: "me" },
      makeContext("Create this in Scanis")
    );

    expect(result.ok).toBe(true);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Update wellness score",
        projectGids: ["project_1"],
        assigneeGid: "user_asana_1"
      })
    );
  });

  it("strips inferred project context when the create request does not mention a project", async () => {
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_create_task",
      {
        name: "test 1",
        dueOn: "2026-05-03",
        projectGids: ["project_2"],
        projectNames: ["School"],
        assigneeGid: "me"
      },
      makeContext("add a test 1 task due tmr")
    );

    expect(result.ok).toBe(true);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "test 1",
        dueOn: "2026-05-03",
        projectGids: undefined,
        assigneeGid: "user_asana_1"
      })
    );
  });

  it("keeps explicit project context when the create request names the project", async () => {
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_create_task",
      {
        name: "test 1",
        dueOn: "2026-05-03",
        projectGids: ["project_2"],
        projectNames: ["Content"],
        assigneeGid: "me"
      },
      makeContext("add a test 1 task in Content due tmr")
    );

    expect(result.ok).toBe(true);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "test 1",
        dueOn: "2026-05-03",
        projectGids: ["project_2"],
        projectNames: ["Content"],
        assigneeGid: "user_asana_1"
      })
    );
  });

  it("strips inferred due dates from task creation when the user did not mention a due date", async () => {
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_create_task",
      {
        name: "test 1",
        dueOn: "2026-05-02",
        projectNames: ["Scanis"],
        assigneeGid: "me"
      },
      makeContext("add a task called test 1 to project Scanis")
    );

    expect(result.ok).toBe(true);
    const createInput = createTaskMock.mock.calls[0]?.[0];
    expect(createInput).toMatchObject({
      name: "test 1",
      assigneeGid: "user_asana_1"
    });
    expect(createInput).not.toHaveProperty("dueOn");
  });

  it("does not treat due/project words inside a task title as due-date instructions", async () => {
    listProjectsMock.mockResolvedValueOnce([
      {
        gid: "project_old",
        name: "Scanis-OLD",
        workspaceGid: "workspace_1",
        workspaceName: "My workspace"
      }
    ]);
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_create_task",
      {
        name: "no due project test",
        dueOn: "2026-05-04",
        assigneeGid: "me"
      },
      makeContext("add a task called no due project test to project Scanis-OLD")
    );

    expect(result.ok).toBe(true);
    const createInput = createTaskMock.mock.calls[0]?.[0];
    expect(createInput).toMatchObject({
      name: "no due project test",
      projectGids: ["project_old"],
      assigneeGid: "user_asana_1"
    });
    expect(createInput).not.toHaveProperty("dueOn");
  });

  it("keeps due dates that are stated outside the task title while recovering project names", async () => {
    listProjectsMock.mockResolvedValueOnce([
      {
        gid: "project_old",
        name: "Scanis-OLD",
        workspaceGid: "workspace_1",
        workspaceName: "My workspace"
      }
    ]);
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_create_task",
      {
        name: "no due project test",
        dueOn: "2026-05-04",
        assigneeGid: "me"
      },
      makeContext("add a task called no due project test to project Scanis-OLD due tomorrow")
    );

    expect(result.ok).toBe(true);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "no due project test",
        dueOn: "2026-05-04",
        projectGids: ["project_old"],
        assigneeGid: "user_asana_1"
      })
    );
  });

  it("verifies project membership after create and returns a backend-authored summary", async () => {
    listProjectsMock.mockResolvedValueOnce([
      {
        gid: "project_business",
        name: "Business",
        workspaceGid: "workspace_1",
        workspaceName: "My workspace"
      }
    ]);
    createTaskMock.mockResolvedValueOnce({
      gid: "task_business",
      name: "due diligence project review",
      completed: false,
      workspaceGid: "workspace_1",
      workspaceName: "My workspace",
      assigneeGid: "user_asana_1",
      assigneeName: "Dhruv"
    });
    getTaskMock.mockResolvedValueOnce({
      gid: "task_business",
      name: "due diligence project review",
      completed: false,
      workspaceGid: "workspace_1",
      workspaceName: "My workspace",
      assigneeGid: "user_asana_1",
      assigneeName: "Dhruv",
      projects: [{ gid: "project_business", name: "Business" }]
    });
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_create_task",
      {
        name: "due diligence project review",
        dueOn: "2026-05-04",
        assigneeGid: "me"
      },
      makeContext("add a task called due diligence project review to project Business")
    );

    expect(result.ok).toBe(true);
    expect(addTaskToProjectMock).toHaveBeenCalledWith("task_business", "project_business");
    expect(result.stopAfterTool).toBe(true);
    expect(result.userMessage).toContain("Created: due diligence project review");
    expect(result.userMessage).toContain("Project: Business");
    expect(result.userMessage).toContain("Due: none");
    expect(result.userMessage).toContain("Assignee: Dhruv");
  });

  it("normalizes null-like assignee strings to the connected Asana user", async () => {
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_create_task",
      { workspaceGid: "workspace_1", name: "Cancel Coddy subscription", assigneeGid: "null" },
      makeContext("Create an Asana task")
    );

    expect(result.ok).toBe(true);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Cancel Coddy subscription",
        assigneeGid: "user_asana_1"
      })
    );
  });

  it("does not pass person-name assignees inferred from task title wording to Asana create", async () => {
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_create_task",
      {
        workspaceGid: "workspace_1",
        name: "add money to Rohan lunch account",
        assigneeGid: "Rohan"
      },
      makeContext("add a task called add money to Rohan lunch account")
    );

    expect(result.ok).toBe(true);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "add money to Rohan lunch account",
        assigneeGid: "user_asana_1"
      })
    );
  });

  it("keeps an explicit real assignee ID for task creation", async () => {
    const executor = makeExecutor();

    const result = await executor.executeToolCall(
      "asana_create_task",
      { workspaceGid: "workspace_1", name: "Assigned task", assigneeGid: "1200000000000001" },
      makeContext("Create an Asana task for Brad")
    );

    expect(result.ok).toBe(true);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Assigned task",
        assigneeGid: "1200000000000001"
      })
    );
  });

  it("retries assigned task creation through PAT fallback when OAuth rejects assigned writes", async () => {
    (env as any).ASANA_PAT_FALLBACK_TOKEN = "pat-token";
    const prisma = makePrisma();
    const executor = makeExecutor(prisma);
    createTaskMock
      .mockRejectedValueOnce(
        new UserFacingError(
          "Asana assignee write unavailable",
          "ASANA_ASSIGNEE_WRITE_UNAVAILABLE",
          "Asana is rejecting assigned task writes right now."
        )
      )
      .mockResolvedValueOnce({
        gid: "task_pat",
        name: "Assigned fallback task",
        completed: false,
        workspaceGid: "workspace_1",
        workspaceName: "Product",
        assigneeGid: "user_asana_1",
        assigneeName: "Dhruv"
      });

    const result = await executor.executeToolCall(
      "asana_create_task",
      {
        workspaceGid: "workspace_1",
        name: "Assigned fallback task",
        dueOn: "2026-05-03",
        assigneeGid: "me"
      },
      makeContext("add an assigned fallback task due tomorrow")
    );

    expect(result.ok).toBe(true);
    expect(createTaskMock).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestPayload: expect.objectContaining({
            authPath: "pat_fallback"
          })
        })
      })
    );
  });

  it("reports fallback configuration clearly when OAuth rejects assigned writes and PAT is unset", async () => {
    (env as any).ASANA_PAT_FALLBACK_TOKEN = "";
    const executor = makeExecutor();
    createTaskMock.mockRejectedValueOnce(
      new UserFacingError(
        "Asana assignee write unavailable",
        "ASANA_ASSIGNEE_WRITE_UNAVAILABLE",
        "Asana is rejecting assigned task writes right now."
      )
    );

    const result = await executor.executeToolCall(
      "asana_create_task",
      {
        workspaceGid: "workspace_1",
        name: "Assigned fallback unavailable task",
        dueOn: "2026-05-03",
        assigneeGid: "me"
      },
      makeContext("add an assigned fallback unavailable task due tomorrow")
    );

    expect(result.ok).toBe(false);
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(result.userMessage).toContain("ASANA_PAT_FALLBACK_TOKEN is not configured");
  });

  it("treats a recent matching created task as success before PAT retrying create", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T20:00:00.000Z"));
    (env as any).ASANA_PAT_FALLBACK_TOKEN = "pat-token";
    const prisma = makePrisma();
    const executor = makeExecutor(prisma);
    createTaskMock.mockRejectedValueOnce(
      new UserFacingError(
        "Asana assignee write unavailable",
        "ASANA_ASSIGNEE_WRITE_UNAVAILABLE",
        "Asana is rejecting assigned task writes right now."
      )
    );
    listMyTasksMock.mockResolvedValueOnce([
      {
        gid: "task_duplicate",
        name: "Duplicate guard task",
        completed: false,
        workspaceGid: "workspace_1",
        workspaceName: "Product",
        dueOn: "2026-05-03",
        assigneeGid: "user_asana_1",
        createdAt: "2026-05-02T19:59:00.000Z"
      }
    ]);

    const result = await executor.executeToolCall(
      "asana_create_task",
      {
        workspaceGid: "workspace_1",
        name: "Duplicate guard task",
        dueOn: "2026-05-03",
        assigneeGid: "me"
      },
      makeContext("add a duplicate guard task due tomorrow")
    );

    expect(result.ok).toBe(true);
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({ gid: "task_duplicate" });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestPayload: expect.objectContaining({
            authPath: "oauth_duplicate_after_failure"
          })
        })
      })
    );
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
      {
        taskGids: ["task_1", "task_2"],
        completed: true,
        source: "recent_list",
        taskPreview: [
          { taskGid: "task_1", name: "First task", projectName: "Scanis" },
          { taskGid: "task_2", name: "Second task", dueOn: "2026-05-25" }
        ]
      },
      makeContext("Complete all listed tasks")
    );

    expect(result.ok).toBe(true);
    expect(result.approvalRequired).toBe(true);
    expect(result.userMessage).toContain("Complete 2 Asana tasks");
    expect(result.userMessage).toContain("First task");
    expect(result.userMessage).toContain("Second task");
    expect(result.userMessage).not.toContain("- task_1");
    expect(prisma.pendingAction.create).toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it("executes confirmed bulk completion for 20 tasks", async () => {
    const executor = makeExecutor();
    const taskGids = Array.from({ length: 20 }, (_, index) => `task_${index + 1}`);
    updateTaskMock.mockImplementation(async ({ taskGid }) => ({
      gid: taskGid,
      name: `Task ${taskGid}`,
      completed: true
    }));

    const result = await executor.executeToolCall(
      "asana_bulk_update_tasks",
      { taskGids, completed: true, source: "recent_list" },
      makeContext("yes"),
      { force: true }
    );

    expect(result.ok).toBe(true);
    expect(updateTaskMock).toHaveBeenCalledTimes(20);
    expect(result.userMessage).toBe(
      "Completed 20 Asana tasks: Task task_1; Task task_2; Task task_3; Task task_4; Task task_5; and 15 more."
    );
  });

  it("retries transient bulk completion failures", async () => {
    const executor = makeExecutor();
    updateTaskMock
      .mockRejectedValueOnce(
        new UserFacingError(
          "Asana rate limited",
          "ASANA_RATE_LIMITED",
          "Asana is rate limiting requests right now."
        )
      )
      .mockResolvedValueOnce({ gid: "task_1", name: "Task 1", completed: true });

    const result = await executor.executeToolCall(
      "asana_bulk_update_tasks",
      { taskGids: ["task_1"], completed: true },
      makeContext("yes"),
      { force: true }
    );

    expect(result.ok).toBe(true);
    expect(updateTaskMock).toHaveBeenCalledTimes(2);
    expect(result.userMessage).toBe("Completed 1 Asana task: Task 1.");
  });

  it("explains when Asana rolls recurring tasks forward after completion", async () => {
    const executor = makeExecutor();
    updateTaskMock.mockResolvedValue({
      gid: "task_1",
      name: "Workout",
      completed: false,
      dueOn: "2026-05-04"
    });

    const result = await executor.executeToolCall(
      "asana_bulk_update_tasks",
      {
        taskGids: ["task_1"],
        completed: true,
        taskPreview: [{ taskGid: "task_1", name: "Workout", dueOn: "2026-04-11" }]
      },
      makeContext("yes"),
      { force: true }
    );

    expect(result.ok).toBe(true);
    expect(result.userMessage).toBe(
      "Completed 1 Asana task: Workout (due 2026-04-11). Recurring note: Workout may still appear open because Asana rolled it to the next occurrence."
    );
  });

  it("does not retry permanent bulk completion failures and stores diagnostics", async () => {
    const prisma = makePrisma();
    const executor = makeExecutor(prisma);
    updateTaskMock.mockRejectedValue(
      new UserFacingError(
        "Asana resource not found",
        "ASANA_NOT_FOUND",
        "I couldn't find that Asana task."
      )
    );

    const result = await executor.executeToolCall(
      "asana_bulk_update_tasks",
      {
        taskGids: ["task_1"],
        completed: true,
        taskPreview: [{ taskGid: "task_1", name: "Missing task" }]
      },
      makeContext("yes"),
      { force: true }
    );

    expect(result.ok).toBe(false);
    expect(updateTaskMock).toHaveBeenCalledTimes(1);
    expect(result.userMessage).toContain("Asana could not find those task IDs");
    expect(prisma.memoryEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_key: { userId: "user_1", key: "last_failed_asana_bulk_update" } }
      })
    );
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
    expect(result.userMessage).toBe(
      "Completed 2 Asana tasks: Ship Asana integration; Ship Asana integration."
    );
  });
});
