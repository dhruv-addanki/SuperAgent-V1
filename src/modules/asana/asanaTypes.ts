export interface AsanaWorkspaceSummary {
  gid: string;
  name: string;
  isOrganization?: boolean;
}

export interface AsanaProjectSummary {
  gid: string;
  name: string;
  workspaceGid?: string;
  workspaceName?: string;
  teamGid?: string;
  teamName?: string;
  archived?: boolean;
}

export interface AsanaTeamSummary {
  gid: string;
  name: string;
  workspaceGid?: string;
  workspaceName?: string;
}

export interface AsanaUserSummary {
  gid: string;
  name: string;
  email?: string;
}

export interface AsanaTaskSummary {
  gid: string;
  name: string;
  completed: boolean;
  completedAt?: string;
  notes?: string;
  dueOn?: string;
  dueAt?: string;
  assigneeGid?: string;
  assigneeName?: string;
  permalinkUrl?: string;
  workspaceGid?: string;
  workspaceName?: string;
  createdAt?: string;
  modifiedAt?: string;
  projects?: Array<{
    gid: string;
    name: string;
  }>;
}

export type AsanaTaskDetail = AsanaTaskSummary;

export interface AsanaDeletedTaskResult {
  taskGid: string;
  name?: string;
  summary: string;
}
