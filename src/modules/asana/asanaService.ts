import { ExternalApiError, UserFacingError } from "../../lib/errors";
import type {
  AsanaDeletedTaskResult,
  AsanaProjectSummary,
  AsanaTaskDetail,
  AsanaTaskSummary,
  AsanaTeamSummary,
  AsanaUserSummary,
  AsanaWorkspaceSummary
} from "./asanaTypes";

const ASANA_API_BASE_URL = "https://app.asana.com/api/1.0";
const MAX_COLLECTION_PAGES = 10;
const MAX_COLLECTION_ITEMS = 500;
const COMPLETED_SINCE_ALL = "1970-01-01T00:00:00.000Z";
const TASK_FIELDS = [
  "gid",
  "name",
  "completed",
  "completed_at",
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
const PROJECT_FIELDS = [
  "gid",
  "name",
  "archived",
  "workspace.gid",
  "workspace.name",
  "team.gid",
  "team.name"
].join(",");
const TEAM_FIELDS = ["gid", "name", "organization.gid", "organization.name"].join(",");
const USER_FIELDS = ["gid", "name", "email"].join(",");

function normalizeWorkspace(workspace: any): AsanaWorkspaceSummary {
  return {
    gid: workspace.gid ?? "",
    name: workspace.name ?? "(Untitled workspace)",
    isOrganization: workspace.is_organization ?? undefined
  };
}

function normalizeTeam(team: any): AsanaTeamSummary {
  return {
    gid: team.gid ?? "",
    name: team.name ?? "(Untitled team)",
    workspaceGid: team.organization?.gid ?? team.workspace?.gid ?? undefined,
    workspaceName: team.organization?.name ?? team.workspace?.name ?? undefined
  };
}

function normalizeProject(project: any): AsanaProjectSummary {
  return {
    gid: project.gid ?? "",
    name: project.name ?? "(Untitled project)",
    workspaceGid: project.workspace?.gid ?? undefined,
    workspaceName: project.workspace?.name ?? undefined,
    teamGid: project.team?.gid ?? undefined,
    teamName: project.team?.name ?? undefined,
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
    completedAt: task.completed_at ?? undefined,
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

function dueDate(task: Pick<AsanaTaskSummary, "dueAt" | "dueOn">): string | undefined {
  if (task.dueOn) return task.dueOn;
  if (task.dueAt) return task.dueAt.slice(0, 10);
  return undefined;
}

function timeValue(value?: string): number {
  if (!value) return Number.NaN;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.NaN : timestamp;
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

function matchesDueDate(task: Pick<AsanaTaskSummary, "dueAt" | "dueOn">, dueOn?: string): boolean {
  if (!dueOn) return true;
  return dueDate(task) === dueOn;
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

function completedSinceForSelection(completed?: boolean): string {
  return completed === true ? COMPLETED_SINCE_ALL : "now";
}

function filterTasks(
  tasks: AsanaTaskSummary[],
  input: {
    completed?: boolean;
    dueBefore?: string;
    dueOn?: string;
    limit?: number;
    sortBy?: "due" | "createdAt" | "modifiedAt" | "completedAt";
    sortDirection?: "asc" | "desc";
  }
): AsanaTaskSummary[] {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const filtered = tasks
    .filter((task) => (input.completed === undefined ? true : task.completed === input.completed))
    .filter((task) => matchesDueDate(task, input.dueOn))
    .filter((task) => beforeDue(task, input.dueBefore));

  const sorted = sortTasks(filtered, input.sortBy, input.sortDirection);
  return sorted.slice(0, limit);
}

function sortTasks(
  tasks: AsanaTaskSummary[],
  sortBy?: "due" | "createdAt" | "modifiedAt" | "completedAt",
  sortDirection: "asc" | "desc" = "asc"
): AsanaTaskSummary[] {
  if (!sortBy) return tasks;

  const direction = sortDirection === "desc" ? -1 : 1;
  const copy = [...tasks];

  copy.sort((left, right) => {
    let leftValue: number;
    let rightValue: number;

    if (sortBy === "due") {
      leftValue = dueTimestamp(left);
      rightValue = dueTimestamp(right);
    } else if (sortBy === "createdAt") {
      leftValue = timeValue(left.createdAt);
      rightValue = timeValue(right.createdAt);
    } else if (sortBy === "modifiedAt") {
      leftValue = timeValue(left.modifiedAt);
      rightValue = timeValue(right.modifiedAt);
    } else {
      leftValue = timeValue(left.completedAt);
      rightValue = timeValue(right.completedAt);
    }

    if (Number.isNaN(leftValue) && Number.isNaN(rightValue)) {
      return left.name.localeCompare(right.name);
    }
    if (Number.isNaN(leftValue)) return 1;
    if (Number.isNaN(rightValue)) return -1;
    if (leftValue === rightValue) return left.name.localeCompare(right.name);
    return (leftValue - rightValue) * direction;
  });

  return copy;
}

interface AsanaDueMutationFields {
  dueOn?: string | null;
  dueAt?: string | null;
}

export class AsanaService {
  constructor(private readonly accessToken: string) {}

  async listWorkspaces(): Promise<AsanaWorkspaceSummary[]> {
    const data = await this.requestCollection<any>("/workspaces", {
      query: {
        limit: "100",
        opt_fields: WORKSPACE_FIELDS
      }
    });

    return sortByName(data.map(normalizeWorkspace).filter((workspace) => workspace.gid));
  }

  async listTeams(workspaceGid: string, query?: string): Promise<AsanaTeamSummary[]> {
    const data = await this.requestCollection<any>(`/workspaces/${workspaceGid}/teams`, {
      query: {
        limit: "100",
        opt_fields: TEAM_FIELDS
      }
    });

    return sortByName(
      data.map(normalizeTeam).filter((team) => team.gid && matchesNameQuery(team.name, query))
    );
  }

  async listProjects(workspaceGid: string, query?: string): Promise<AsanaProjectSummary[]> {
    const [workspaceProjects, teams] = await Promise.all([
      this.requestCollection<any>(`/workspaces/${workspaceGid}/projects`, {
        query: {
          limit: "100",
          opt_fields: PROJECT_FIELDS
        }
      }),
      this.listTeams(workspaceGid)
    ]);

    const teamProjectResponses = await Promise.allSettled(
      teams.map((team) =>
        this.requestCollection<any>(`/teams/${team.gid}/projects`, {
          query: {
            limit: "100",
            opt_fields: PROJECT_FIELDS
          }
        })
      )
    );

    const projectMap = new Map<string, AsanaProjectSummary>();

    const remember = (project: AsanaProjectSummary, fallbackTeam?: AsanaTeamSummary) => {
      if (!project.gid || !matchesNameQuery(project.name, query)) return;

      const existing = projectMap.get(project.gid);
      projectMap.set(project.gid, {
        ...existing,
        ...project,
        teamGid: project.teamGid ?? existing?.teamGid ?? fallbackTeam?.gid,
        teamName: project.teamName ?? existing?.teamName ?? fallbackTeam?.name,
        workspaceGid: project.workspaceGid ?? existing?.workspaceGid ?? fallbackTeam?.workspaceGid,
        workspaceName:
          project.workspaceName ?? existing?.workspaceName ?? fallbackTeam?.workspaceName
      });
    };

    for (const project of workspaceProjects.map(normalizeProject)) {
      remember(project);
    }

    teamProjectResponses.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      const fallbackTeam = teams[index];
      for (const project of result.value.map(normalizeProject)) {
        remember(project, fallbackTeam);
      }
    });

    return sortByName(Array.from(projectMap.values()));
  }

  async listUsers(workspaceGid: string, query?: string): Promise<AsanaUserSummary[]> {
    const data = await this.requestCollection<any>(`/workspaces/${workspaceGid}/users`, {
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
    workspaceGid: string;
    completed?: boolean;
    dueBefore?: string;
    dueOn?: string;
    limit?: number;
    sortBy?: "due" | "createdAt" | "modifiedAt" | "completedAt";
    sortDirection?: "asc" | "desc";
  }): Promise<AsanaTaskSummary[]> {
    const fetchLimit = Math.min(Math.max((input.limit ?? 20) * 5, 50), MAX_COLLECTION_ITEMS);
    const pageSize = Math.min(fetchLimit, 100);
    const completedSince = completedSinceForSelection(input.completed);

    try {
      const userTaskList = await this.request<{ gid?: string }>("/users/me/user_task_list", {
        query: {
          workspace: input.workspaceGid,
          opt_fields: "gid"
        }
      });

      if (!userTaskList.gid) {
        throw new UserFacingError(
          "Asana user task list missing",
          "ASANA_MY_TASKS_UNAVAILABLE",
          "I couldn't read Asana My Tasks for that workspace. Ask me to check a project instead."
        );
      }

      const data = await this.requestCollection<any>(`/user_task_lists/${userTaskList.gid}/tasks`, {
        query: {
          limit: String(pageSize),
          opt_fields: TASK_FIELDS,
          completed_since: completedSince
        }
      }, {
        maxItems: fetchLimit
      });

      return filterTasks(data.map(normalizeTask).filter((task) => task.gid), input);
    } catch (error) {
      if (!this.shouldFallbackToWorkspaceTaskList(error)) throw error;

      const fallbackData = await this.requestCollection<any>("/tasks", {
        query: {
          assignee: "me",
          workspace: input.workspaceGid,
          limit: String(pageSize),
          completed_since: completedSince,
          opt_fields: TASK_FIELDS
        }
      }, {
        maxItems: fetchLimit
      });

      return filterTasks(fallbackData.map(normalizeTask).filter((task) => task.gid), input);
    }
  }

  async listProjectTasks(input: {
    projectGid: string;
    completed?: boolean;
    dueBefore?: string;
    dueOn?: string;
    limit?: number;
    sortBy?: "due" | "createdAt" | "modifiedAt" | "completedAt";
    sortDirection?: "asc" | "desc";
  }): Promise<AsanaTaskSummary[]> {
    const fetchLimit = Math.min(Math.max((input.limit ?? 20) * 5, 50), MAX_COLLECTION_ITEMS);
    const pageSize = Math.min(fetchLimit, 100);
    const data = await this.requestCollection<any>(`/projects/${input.projectGid}/tasks`, {
      query: {
        limit: String(pageSize),
        opt_fields: TASK_FIELDS,
        completed_since: completedSinceForSelection(input.completed)
      }
    }, {
      maxItems: fetchLimit
    });

    return filterTasks(data.map(normalizeTask).filter((task) => task.gid), input);
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
    const data = await this.requestCollection<any>(`/workspaces/${input.workspaceGid}/tasks/search`, {
      query: {
        text: input.text,
        "projects.any": input.projectGid,
        "assignee.any": input.assigneeGid,
        completed: input.completed === undefined ? undefined : String(input.completed),
        limit: String(limit),
        sort_by: "modified_at",
        opt_fields: TASK_FIELDS
      }
    }, {
      maxItems: limit
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
    const dueFields = await this.resolveDueMutationFields({
      dueOn: input.dueOn,
      dueAt: input.dueAt
    });

    const data = await this.request<any>("/tasks", {
      method: "POST",
      query: {
        opt_fields: TASK_FIELDS
      },
      body: {
        data: this.buildTaskMutationData(
          {
            name: input.name,
            workspace: input.workspaceGid,
            notes: input.notes,
            assignee: input.assigneeGid,
            projects: input.projectGids
          },
          dueFields
        )
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
    const dueFields = await this.resolveDueMutationFields(
      {
        dueOn: input.dueOn,
        dueAt: input.dueAt
      },
      input.taskGid
    );

    const data = await this.request<any>(`/tasks/${input.taskGid}`, {
      method: "PUT",
      query: {
        opt_fields: TASK_FIELDS
      },
      body: {
        data: this.buildTaskMutationData(
          {
            name: input.name,
            notes: input.notes,
            assignee: input.assigneeGid,
            completed: input.completed
          },
          dueFields
        )
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

  private shouldFallbackToWorkspaceTaskList(error: unknown): boolean {
    return (
      error instanceof UserFacingError &&
      [
        "ASANA_BAD_REQUEST",
        "ASANA_FORBIDDEN",
        "ASANA_MY_TASKS_UNAVAILABLE",
        "ASANA_NOT_FOUND"
      ].includes(error.code)
    );
  }

  private async resolveDueMutationFields(
    input: AsanaDueMutationFields,
    taskGid?: string
  ): Promise<AsanaDueMutationFields> {
    const hasDueOn = Object.prototype.hasOwnProperty.call(input, "dueOn");
    const hasDueAt = Object.prototype.hasOwnProperty.call(input, "dueAt");

    if (!hasDueOn && !hasDueAt) return {};

    if (input.dueOn === null && input.dueAt === null) {
      if (taskGid) {
        const currentTask = await this.getTask(taskGid);
        if (currentTask.dueAt) return { dueAt: null };
        if (currentTask.dueOn) return { dueOn: null };
      }
      return { dueOn: null };
    }

    if (input.dueOn === null && input.dueAt !== undefined) {
      return input.dueAt === null
        ? { dueOn: null }
        : typeof input.dueAt === "string"
          ? { dueAt: input.dueAt }
          : { dueOn: null };
    }

    if (input.dueAt === null && input.dueOn !== undefined) {
      return input.dueOn === null
        ? { dueOn: null }
        : typeof input.dueOn === "string"
          ? { dueOn: input.dueOn }
          : { dueAt: null };
    }

    if (typeof input.dueOn === "string" && typeof input.dueAt === "string") {
      return { dueAt: input.dueAt };
    }

    if (input.dueOn !== undefined) return { dueOn: input.dueOn };
    if (input.dueAt !== undefined) return { dueAt: input.dueAt };
    return {};
  }

  private buildTaskMutationData(
    base: Record<string, unknown>,
    dueFields: AsanaDueMutationFields
  ): Record<string, unknown> {
    const data: Record<string, unknown> = { ...base };

    if (Object.prototype.hasOwnProperty.call(dueFields, "dueOn")) {
      data.due_on = dueFields.dueOn;
    }

    if (Object.prototype.hasOwnProperty.call(dueFields, "dueAt")) {
      data.due_at = dueFields.dueAt;
    }

    return data;
  }

  private async requestCollection<T>(
    path: string,
    input: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      query?: Record<string, string | undefined>;
      body?: unknown;
    } = {},
    options: {
      maxItems?: number;
    } = {}
  ): Promise<T[]> {
    const items: T[] = [];
    let offset: string | undefined;
    let pages = 0;

    do {
      const query = {
        ...(input.query ?? {}),
        ...(offset ? { offset } : {})
      };
      const result = await this.executeRequest<T[]>(path, {
        ...input,
        query
      });

      items.push(...(result.data ?? []));
      offset = result.nextPageOffset;
      pages += 1;
    } while (
      offset &&
      items.length < (options.maxItems ?? MAX_COLLECTION_ITEMS) &&
      pages < MAX_COLLECTION_PAGES
    );

    return items.slice(0, options.maxItems ?? MAX_COLLECTION_ITEMS);
  }

  private async request<T>(
    path: string,
    input: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      query?: Record<string, string | undefined>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    const result = await this.executeRequest<T>(path, input);

    if (result.data === undefined && input.method !== "DELETE") {
      throw new Error(`Asana response missing data for ${path}`);
    }

    return (result.data ?? {}) as T;
  }

  private async executeRequest<T>(
    path: string,
    input: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      query?: Record<string, string | undefined>;
      body?: unknown;
    } = {}
  ): Promise<{ data?: T; nextPageOffset?: string }> {
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
      next_page?: { offset?: string | null };
    };

    if (!response.ok) {
      throw this.mapError(response.status, path, payload.errors?.[0]?.message);
    }

    return {
      data: payload.data,
      nextPageOffset: payload.next_page?.offset ?? undefined
    };
  }

  private mapError(status: number, path: string, detail?: string): Error {
    if (status === 400 && path.includes("/users/me/user_task_list")) {
      return new UserFacingError(
        "Asana My Tasks unavailable",
        "ASANA_MY_TASKS_UNAVAILABLE",
        "I couldn't read Asana My Tasks for that workspace. Ask me to check a project instead."
      );
    }

    if (status === 400) {
      return new UserFacingError(
        "Asana rejected request",
        "ASANA_BAD_REQUEST",
        detail
          ? `Asana rejected that request: ${detail}`
          : "Asana rejected that request. Try a simpler project, task, or workspace request."
      );
    }

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
        "Your Asana account does not have access to that workspace, project, team, or task."
      );
    }

    if (status === 404) {
      return new UserFacingError(
        "Asana resource not found",
        "ASANA_NOT_FOUND",
        "I couldn't find that Asana task, project, team, or workspace."
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
