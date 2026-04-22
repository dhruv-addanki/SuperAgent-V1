import { ExternalApiError, UserFacingError } from "../../lib/errors";
import type {
  AsanaDeletedTaskResult,
  AsanaProjectSummary,
  AsanaTaskDetail,
  AsanaTaskSummary,
  AsanaUserSummary,
  AsanaWorkspaceSummary
} from "./asanaTypes";

const ASANA_API_BASE_URL = "https://app.asana.com/api/1.0";
const TASK_FIELDS = [
  "gid",
  "name",
  "completed",
  "notes",
  "due_on",
  "due_at",
  "assignee.gid",
  "assignee.name",
  "workspace.gid",
  "workspace.name",
  "projects.gid",
  "projects.name",
  "permalink_url",
  "created_at",
  "modified_at"
].join(",");
const WORKSPACE_FIELDS = ["gid", "name", "is_organization"].join(",");
const PROJECT_FIELDS = ["gid", "name", "archived", "workspace.gid", "workspace.name"].join(",");
const USER_FIELDS = ["gid", "name", "email"].join(",");

function normalizeWorkspace(workspace: any): AsanaWorkspaceSummary {
  return {
    gid: workspace.gid ?? "",
    name: workspace.name ?? "(Untitled workspace)",
    isOrganization: workspace.is_organization ?? undefined
  };
}

function normalizeProject(project: any): AsanaProjectSummary {
  return {
    gid: project.gid ?? "",
    name: project.name ?? "(Untitled project)",
    workspaceGid: project.workspace?.gid ?? undefined,
    workspaceName: project.workspace?.name ?? undefined,
    archived: project.archived ?? undefined
  };
}

function normalizeUser(user: any): AsanaUserSummary {
  return {
    gid: user.gid ?? "",
    name: user.name ?? "(Unnamed user)",
    email: user.email ?? undefined
  };
}

function normalizeTask(task: any): AsanaTaskDetail {
  return {
    gid: task.gid ?? "",
    name: task.name ?? "(Untitled task)",
    completed: Boolean(task.completed),
    notes: task.notes ?? undefined,
    dueOn: task.due_on ?? undefined,
    dueAt: task.due_at ?? undefined,
    assigneeGid: task.assignee?.gid ?? undefined,
    assigneeName: task.assignee?.name ?? undefined,
    permalinkUrl: task.permalink_url ?? undefined,
    workspaceGid: task.workspace?.gid ?? undefined,
    workspaceName: task.workspace?.name ?? undefined,
    projects: (task.projects ?? [])
      .map((project: any) => ({
        gid: project.gid ?? "",
        name: project.name ?? "(Untitled project)"
      }))
      .filter((project: { gid: string }) => Boolean(project.gid)),
    createdAt: task.created_at ?? undefined,
    modifiedAt: task.modified_at ?? undefined
  };
}

function matchesNameQuery(name: string, query?: string): boolean {
  if (!query) return true;
  return name.toLowerCase().includes(query.trim().toLowerCase());
}

function dueTimestamp(task: Pick<AsanaTaskSummary, "dueAt" | "dueOn">): number {
  const value = task.dueAt ?? task.dueOn;
  if (!value) return Number.MAX_SAFE_INTEGER;
  const timestamp =
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T23:59:59.999Z`) : Date.parse(value);
  return Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp;
}

function beforeDue(task: Pick<AsanaTaskSummary, "dueAt" | "dueOn">, dueBefore?: string): boolean {
  if (!dueBefore) return true;
  const filterTimestamp =
    /^\d{4}-\d{2}-\d{2}$/.test(dueBefore)
      ? Date.parse(`${dueBefore}T23:59:59.999Z`)
      : Date.parse(dueBefore);
  if (Number.isNaN(filterTimestamp)) return true;
  return dueTimestamp(task) <= filterTimestamp;
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

export class AsanaService {
  constructor(private readonly accessToken: string) {}

  async listWorkspaces(): Promise<AsanaWorkspaceSummary[]> {
    const data = await this.request<any[]>("/workspaces", {
      query: {
        limit: "100",
        opt_fields: WORKSPACE_FIELDS
      }
    });

    return sortByName(data.map(normalizeWorkspace).filter((workspace) => workspace.gid));
  }

  async listProjects(workspaceGid: string, query?: string): Promise<AsanaProjectSummary[]> {
    const data = await this.request<any[]>(`/workspaces/${workspaceGid}/projects`, {
      query: {
        limit: "100",
        opt_fields: PROJECT_FIELDS
      }
    });

    return sortByName(
      data
        .map(normalizeProject)
        .filter((project) => project.gid && matchesNameQuery(project.name, query))
    );
  }

  async listUsers(workspaceGid: string, query?: string): Promise<AsanaUserSummary[]> {
    const data = await this.request<any[]>(`/workspaces/${workspaceGid}/users`, {
      query: {
        limit: "100",
        opt_fields: USER_FIELDS
      }
    });

    return sortByName(
      data.map(normalizeUser).filter((user) => user.gid && matchesNameQuery(user.name, query))
    );
  }

  async listMyTasks(input: {
    workspaceGid?: string;
    projectGid?: string;
    completed?: boolean;
    dueBefore?: string;
    limit?: number;
  }): Promise<AsanaTaskSummary[]> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const pageSize = Math.min(Math.max(limit * 3, 25), 100);

    let data: any[];
    if (input.projectGid) {
      data = await this.request<any[]>(`/projects/${input.projectGid}/tasks`, {
        query: {
          limit: String(pageSize),
          opt_fields: TASK_FIELDS,
          completed_since: input.completed === false ? "now" : undefined
        }
      });
    } else {
      if (!input.workspaceGid) {
        throw new UserFacingError(
          "Missing Asana workspace",
          "ASANA_WORKSPACE_REQUIRED",
          "Choose an Asana workspace first."
        );
      }

      const userTaskList = await this.request<{ gid?: string }>("/users/me/user_task_list", {
        query: {
          workspace: input.workspaceGid,
          opt_fields: "gid"
        }
      });

      if (!userTaskList.gid) {
        throw new Error("Asana did not return a user task list ID");
      }

      data = await this.request<any[]>(`/user_task_lists/${userTaskList.gid}/tasks`, {
        query: {
          limit: String(pageSize),
          opt_fields: TASK_FIELDS,
          completed_since: input.completed === false ? "now" : undefined
        }
      });
    }

    return data
      .map(normalizeTask)
      .filter((task) => task.gid)
      .filter((task) => (input.completed === undefined ? true : task.completed === input.completed))
      .filter((task) => beforeDue(task, input.dueBefore))
      .slice(0, limit);
  }

  async searchTasks(input: {
    workspaceGid: string;
    text: string;
    projectGid?: string;
    assigneeGid?: string;
    completed?: boolean;
    limit?: number;
  }): Promise<AsanaTaskSummary[]> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const data = await this.request<any[]>(`/workspaces/${input.workspaceGid}/tasks/search`, {
      query: {
        text: input.text,
        "projects.any": input.projectGid,
        "assignee.any": input.assigneeGid,
        completed: input.completed === undefined ? undefined : String(input.completed),
        limit: String(limit),
        sort_by: "modified_at",
        opt_fields: TASK_FIELDS
      }
    });

    return data.map(normalizeTask).filter((task) => task.gid);
  }

  async getTask(taskGid: string): Promise<AsanaTaskDetail> {
    const data = await this.request<any>(`/tasks/${taskGid}`, {
      query: {
        opt_fields: TASK_FIELDS
      }
    });

    return normalizeTask(data);
  }

  async createTask(input: {
    workspaceGid?: string;
    name: string;
    notes?: string;
    dueOn?: string;
    dueAt?: string;
    assigneeGid?: string;
    projectGids?: string[];
  }): Promise<AsanaTaskDetail> {
    const data = await this.request<any>("/tasks", {
      method: "POST",
      query: {
        opt_fields: TASK_FIELDS
      },
      body: {
        data: {
          name: input.name,
          workspace: input.workspaceGid,
          notes: input.notes,
          due_on: input.dueOn,
          due_at: input.dueAt,
          assignee: input.assigneeGid,
          projects: input.projectGids
        }
      }
    });

    return normalizeTask(data);
  }

  async updateTask(input: {
    taskGid: string;
    name?: string;
    notes?: string;
    dueOn?: string | null;
    dueAt?: string | null;
    assigneeGid?: string | null;
    completed?: boolean;
  }): Promise<AsanaTaskDetail> {
    const data = await this.request<any>(`/tasks/${input.taskGid}`, {
      method: "PUT",
      query: {
        opt_fields: TASK_FIELDS
      },
      body: {
        data: {
          name: input.name,
          notes: input.notes,
          due_on: input.dueOn,
          due_at: input.dueAt,
          assignee: input.assigneeGid,
          completed: input.completed
        }
      }
    });

    return normalizeTask(data);
  }

  async deleteTask(taskGid: string): Promise<AsanaDeletedTaskResult> {
    const task = await this.request<any>(`/tasks/${taskGid}`, {
      query: {
        opt_fields: "gid,name"
      }
    });

    await this.request<unknown>(`/tasks/${taskGid}`, {
      method: "DELETE"
    });

    return {
      taskGid,
      name: task.name ?? undefined,
      summary: `Deleted Asana task: ${task.name ?? "task"}`
    };
  }

  private async request<T>(
    path: string,
    input: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      query?: Record<string, string | undefined>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    const url = new URL(`${ASANA_API_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url, {
      method: input.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
        ...(input.body ? { "Content-Type": "application/json" } : {})
      },
      body: input.body ? JSON.stringify(input.body) : undefined
    });

    const payload = (await response.json().catch(() => ({}))) as {
      data?: T;
      errors?: Array<{ message?: string }>;
    };

    if (!response.ok) {
      throw this.mapError(response.status, path, payload.errors?.[0]?.message);
    }

    if (payload.data === undefined && input.method !== "DELETE") {
      throw new Error(`Asana response missing data for ${path}`);
    }

    return (payload.data ?? {}) as T;
  }

  private mapError(status: number, path: string, detail?: string): Error {
    if (status === 401) {
      return new UserFacingError(
        "Asana auth expired",
        "ASANA_AUTH_EXPIRED",
        "Reconnect your Asana account and try again."
      );
    }

    if (status === 402 && path.includes("/tasks/search")) {
      return new UserFacingError(
        "Asana premium search required",
        "ASANA_SEARCH_PREMIUM_REQUIRED",
        "Asana task search is only available on premium workspaces. Ask me to check My Tasks or a specific project instead."
      );
    }

    if (status === 403 && detail?.toLowerCase().includes("scope")) {
      return new UserFacingError(
        "Asana scope missing",
        "ASANA_SCOPE_MISSING",
        "Reconnect your Asana account to grant the missing access and try again."
      );
    }

    if (status === 403) {
      return new UserFacingError(
        "Asana permission denied",
        "ASANA_FORBIDDEN",
        "Your Asana account does not have access to that workspace, project, or task."
      );
    }

    if (status === 404) {
      return new UserFacingError(
        "Asana resource not found",
        "ASANA_NOT_FOUND",
        "I couldn't find that Asana task, project, or workspace."
      );
    }

    if (status === 429) {
      return new UserFacingError(
        "Asana rate limited",
        "ASANA_RATE_LIMITED",
        "Asana is rate limiting requests right now. Please try again in a minute."
      );
    }

    return new ExternalApiError("asana", "I couldn't reach Asana right now.", detail);
  }
}
