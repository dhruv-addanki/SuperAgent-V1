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
  notes?: string;
  dueOn?: string;
  dueAt?: string;
  assigneeGid?: string;
  assigneeName?: string;
  permalinkUrl?: string;
  workspaceGid?: string;
  workspaceName?: string;
  projects?: Array<{
    gid: string;
    name: string;
  }>;
}

export interface AsanaTaskDetail extends AsanaTaskSummary {
  createdAt?: string;
  modifiedAt?: string;
}

export interface AsanaDeletedTaskResult {
  taskGid: string;
  name?: string;
  summary: string;
}
