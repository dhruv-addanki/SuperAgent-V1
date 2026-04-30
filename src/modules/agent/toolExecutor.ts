import {
  PendingActionStatus,
  type Conversation,
  type PendingAction,
  type PrismaClient,
  type User
} from "@prisma/client";
import { env } from "../../config/env";
import { AuditService } from "../audit/auditService";
import { AsanaService } from "../asana/asanaService";
import { AsanaTokenService } from "../asana/tokenService";
import type { AsanaProjectSummary, AsanaTaskSummary, AsanaTeamSummary } from "../asana/asanaTypes";
import { CalendarService } from "../google/calendarService";
import { DocsService } from "../google/docsService";
import { DriveService } from "../google/driveService";
import { GmailService } from "../google/gmailService";
import { GoogleTokenService } from "../google/tokenService";
import { NotionService } from "../notion/notionService";
import { NotionTokenService } from "../notion/tokenService";
import type { NotionPageSummary } from "../notion/notionTypes";
import {
  AutomationService,
  formatAutomationCreated,
  formatAutomationList,
  summarizeAutomation
} from "../automation/automationService";
import { WebSearchService } from "./webSearchService";
import {
  createPendingAction,
  expectedConfirmationForPayload,
  getApprovalDecision,
  matchesPositiveConfirmation,
  type PendingToolPayload
} from "./approvalPolicy";
import {
  isToolName,
  isWriteTool,
  toolInputSchemas,
  type ToolName
} from "../../schemas/toolSchemas";
import { serializeError, UserFacingError, userMessageForError } from "../../lib/errors";
import { formatForUser } from "../../lib/time";
import type {
  CalendarEventSummary,
  CalendarSummary,
  DriveFileSummary,
  GmailThreadMessage,
  GmailThreadSummary
} from "../google/googleTypes";

export interface ToolExecutionContext {
  user: User;
  conversation: Conversation;
  latestUserMessage: string;
}

export interface ToolExecutionResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  userMessage?: string;
  approvalRequired?: boolean;
  stopAfterTool?: boolean;
}

const NO_DUE_DATE_PATTERNS = [
  /\bno due date\b/,
  /\bwithout (?:a |any )?due date\b/,
  /\bno deadline\b/,
  /\bwithout (?:a )?deadline\b/,
  /\b(?:remove|clear)\s+(?:the\s+)?due date\b/,
  /\b(?:don't|do not|dont)\s+(?:set|add|include)\s+(?:a\s+)?due date\b/,
  /\bno due needed\b/,
  /\bno date needed\b/
];
const TIME_OF_DAY_PATTERN =
  /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\bnoon\b|\bmidnight\b/i;
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";

function requestsNoDueDate(latestUserMessage: string): boolean {
  const normalized = latestUserMessage.toLowerCase().replace(/[’]/g, "'");
  return NO_DUE_DATE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function mentionsExplicitDueTime(latestUserMessage: string): boolean {
  return TIME_OF_DAY_PATTERN.test(latestUserMessage);
}

function normalizeAsanaWriteInput(toolName: ToolName, input: any, latestUserMessage: string): any {
  if (toolName !== "asana_create_task" && toolName !== "asana_update_task") {
    return input;
  }

  const normalized = { ...input };
  const hasDueOn = Object.prototype.hasOwnProperty.call(normalized, "dueOn");
  const hasDueAt = Object.prototype.hasOwnProperty.call(normalized, "dueAt");

  if (!hasDueOn && !hasDueAt) return normalized;

  if (requestsNoDueDate(latestUserMessage)) {
    if (toolName === "asana_create_task") {
      delete normalized.dueOn;
      delete normalized.dueAt;
    } else {
      normalized.dueOn = null;
      normalized.dueAt = null;
    }
    return normalized;
  }

  const dueOn = normalized.dueOn;
  const dueAt = normalized.dueAt;

  if (dueOn === null && dueAt !== undefined && dueAt !== null) {
    delete normalized.dueOn;
    return normalized;
  }

  if (dueAt === null && dueOn !== undefined && dueOn !== null) {
    delete normalized.dueAt;
    return normalized;
  }

  if (typeof dueOn === "string" && typeof dueAt === "string") {
    if (mentionsExplicitDueTime(latestUserMessage)) {
      delete normalized.dueOn;
    } else {
      delete normalized.dueAt;
    }
  }

  return normalized;
}

function normalizeAutomationCreateInput(
  toolName: ToolName,
  input: any,
  defaultTimezone: string
): any {
  if (toolName !== "automation_create") return input;
  return {
    ...input,
    timezone: input.timezone || defaultTimezone
  };
}

export class ToolExecutor {
  private readonly audit: AuditService;
  private readonly automationService: AutomationService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly googleTokenService: GoogleTokenService,
    private readonly asanaTokenService: AsanaTokenService,
    private readonly notionTokenService: NotionTokenService = new NotionTokenService(prisma)
  ) {
    this.audit = new AuditService(prisma);
    this.automationService = new AutomationService(prisma);
  }

  private async rememberRecentDocument(
    userId: string,
    document: { documentId: string; title: string; url?: string }
  ): Promise<void> {
    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "recent_google_doc" } },
      update: {
        value: {
          documentId: document.documentId,
          title: document.title,
          url: document.url
        },
        confidence: 1
      },
      create: {
        userId,
        key: "recent_google_doc",
        value: {
          documentId: document.documentId,
          title: document.title,
          url: document.url
        },
        confidence: 1
      }
    });
  }

  private async rememberRecentGmailThreads(
    userId: string,
    threads: GmailThreadSummary[]
  ): Promise<void> {
    const normalizedThreads = threads.slice(0, 10).map((thread) => ({
      threadId: thread.threadId,
      subject: thread.subject,
      from: thread.from,
      date: thread.date,
      snippet: thread.snippet
    }));

    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "recent_gmail_threads" } },
      update: {
        value: normalizedThreads,
        confidence: 1
      },
      create: {
        userId,
        key: "recent_gmail_threads",
        value: normalizedThreads,
        confidence: 1
      }
    });
  }

  private async rememberRecentGmailThreadMessages(
    userId: string,
    messages: GmailThreadMessage[]
  ): Promise<void> {
    const first = messages[0];
    if (!first?.threadId) return;

    await this.rememberRecentGmailThreads(userId, [
      {
        threadId: first.threadId,
        subject: first.subject,
        from: first.from,
        date: first.date,
        snippet: first.snippet ?? first.bodyText?.slice(0, 160)
      }
    ]);
  }

  private async rememberRecentCalendars(
    userId: string,
    calendars: CalendarSummary[]
  ): Promise<void> {
    const normalizedCalendars = calendars.slice(0, 10).map((calendar) => ({
      calendarId: calendar.id,
      summary: calendar.summary,
      primary: calendar.primary,
      accessRole: calendar.accessRole
    }));

    if (!normalizedCalendars.length) return;

    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "recent_calendars" } },
      update: {
        value: normalizedCalendars,
        confidence: 1
      },
      create: {
        userId,
        key: "recent_calendars",
        value: normalizedCalendars,
        confidence: 1
      }
    });
  }

  private async rememberRecentCalendarEvents(
    userId: string,
    events: CalendarEventSummary[]
  ): Promise<void> {
    const normalizedEvents = events
      .filter((event) => event.id)
      .slice(0, 10)
      .map((event) => ({
        eventId: event.id!,
        title: event.title,
        start: event.start,
        end: event.end,
        calendarId: event.calendarId,
        calendarSummary: event.calendarSummary,
        htmlLink: event.htmlLink
      }));

    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "recent_calendar_events" } },
      update: {
        value: normalizedEvents,
        confidence: 1
      },
      create: {
        userId,
        key: "recent_calendar_events",
        value: normalizedEvents,
        confidence: 1
      }
    });
  }

  private async getExcludedCalendarNames(userId: string): Promise<string[]> {
    const memoryEntry = await (this.prisma as any).memoryEntry?.findUnique?.({
      where: { userId_key: { userId, key: "calendar_exclusion_preferences" } }
    });
    const excluded = memoryEntry?.value?.excludedCalendarNames;
    if (!Array.isArray(excluded)) return [];
    return excluded
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .map((value) => value.trim().toLowerCase());
  }

  private async applyCalendarExclusions(
    userId: string,
    events: CalendarEventSummary[]
  ): Promise<CalendarEventSummary[]> {
    const excludedNames = await this.getExcludedCalendarNames(userId);
    if (!excludedNames.length) return events;
    return events.filter((event) => {
      const summary = event.calendarSummary?.trim().toLowerCase();
      return !summary || !excludedNames.includes(summary);
    });
  }

  private async rememberRecentDriveFiles(userId: string, files: DriveFileSummary[]): Promise<void> {
    const normalizedFiles = files
      .filter((file) => file.id)
      .slice(0, 10)
      .map((file) => ({
        fileId: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        webViewLink: file.webViewLink
      }));

    if (!normalizedFiles.length) return;

    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "recent_drive_files" } },
      update: {
        value: normalizedFiles,
        confidence: 1
      },
      create: {
        userId,
        key: "recent_drive_files",
        value: normalizedFiles,
        confidence: 1
      }
    });
  }

  private async rememberRecentGoogleDocFromDriveFiles(
    userId: string,
    files: DriveFileSummary[]
  ): Promise<void> {
    const googleDocs = files.filter((file) => file.id && file.mimeType === GOOGLE_DOC_MIME_TYPE);
    if (googleDocs.length !== 1) return;

    const doc = googleDocs[0]!;
    await this.rememberRecentDocument(userId, {
      documentId: doc.id,
      title: doc.name,
      url: doc.webViewLink
    });
  }

  private async forgetRecentGoogleDocIfDeleted(userId: string, fileId: string): Promise<void> {
    const delegate = (this.prisma as any).memoryEntry;
    if (!delegate?.findUnique || !delegate?.delete) return;

    const entry = await delegate.findUnique({
      where: { userId_key: { userId, key: "recent_google_doc" } }
    });
    const documentId =
      entry?.value &&
      typeof entry.value === "object" &&
      typeof (entry.value as { documentId?: unknown }).documentId === "string"
        ? (entry.value as { documentId: string }).documentId
        : null;

    if (documentId !== fileId) return;
    await delegate.delete({
      where: { userId_key: { userId, key: "recent_google_doc" } }
    });
  }

  private async rememberRecentNotionPages(
    userId: string,
    pages: NotionPageSummary[]
  ): Promise<void> {
    const normalizedPages = pages
      .filter((page) => page.pageId)
      .slice(0, 10)
      .map((page) => ({
        pageId: page.pageId,
        title: page.title,
        url: page.url,
        lastEditedTime: page.lastEditedTime,
        parentType: page.parentType,
        parentId: page.parentId
      }));

    if (!normalizedPages.length) return;

    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "recent_notion_pages" } },
      update: {
        value: normalizedPages,
        confidence: 1
      },
      create: {
        userId,
        key: "recent_notion_pages",
        value: normalizedPages,
        confidence: 1
      }
    });
  }

  private async rememberRecentNotionPage(userId: string, page: NotionPageSummary): Promise<void> {
    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "recent_notion_page" } },
      update: {
        value: {
          pageId: page.pageId,
          title: page.title,
          url: page.url,
          lastEditedTime: page.lastEditedTime,
          parentType: page.parentType,
          parentId: page.parentId
        },
        confidence: 1
      },
      create: {
        userId,
        key: "recent_notion_page",
        value: {
          pageId: page.pageId,
          title: page.title,
          url: page.url,
          lastEditedTime: page.lastEditedTime,
          parentType: page.parentType,
          parentId: page.parentId
        },
        confidence: 1
      }
    });
  }

  private async rememberRecentAsanaWorkspace(
    userId: string,
    workspace: { workspaceGid: string; name?: string }
  ): Promise<void> {
    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "recent_asana_workspace" } },
      update: {
        value: {
          workspaceGid: workspace.workspaceGid,
          name: workspace.name
        },
        confidence: 1
      },
      create: {
        userId,
        key: "recent_asana_workspace",
        value: {
          workspaceGid: workspace.workspaceGid,
          name: workspace.name
        },
        confidence: 1
      }
    });
  }

  private async rememberRecentAsanaTasks(userId: string, tasks: AsanaTaskSummary[]): Promise<void> {
    const normalizedTasks = tasks.slice(0, 10).map((task) => ({
      taskGid: task.gid,
      name: task.name,
      completed: task.completed,
      completedAt: task.completedAt,
      dueOn: task.dueOn,
      dueAt: task.dueAt,
      assigneeGid: task.assigneeGid,
      assigneeName: task.assigneeName,
      workspaceGid: task.workspaceGid,
      workspaceName: task.workspaceName,
      createdAt: task.createdAt,
      modifiedAt: task.modifiedAt,
      projectName: task.projects?.[0]?.name,
      permalinkUrl: task.permalinkUrl
    }));

    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "recent_asana_tasks" } },
      update: {
        value: normalizedTasks,
        confidence: 1
      },
      create: {
        userId,
        key: "recent_asana_tasks",
        value: normalizedTasks,
        confidence: 1
      }
    });
  }

  private async rememberRecentAsanaProjects(
    userId: string,
    projects: Array<
      AsanaProjectSummary & {
        teamGid?: string;
        teamName?: string;
      }
    >
  ): Promise<void> {
    const normalizedProjects = Array.from(
      new Map(
        projects
          .filter((project) => project.gid)
          .slice(0, 25)
          .map((project) => [
            project.gid,
            {
              projectGid: project.gid,
              name: project.name ?? "(Untitled project)",
              workspaceGid: project.workspaceGid,
              workspaceName: project.workspaceName,
              teamGid: project.teamGid,
              teamName: project.teamName,
              archived: project.archived
            }
          ])
      ).values()
    );

    if (!normalizedProjects.length) return;

    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "recent_asana_projects" } },
      update: {
        value: normalizedProjects,
        confidence: 1
      },
      create: {
        userId,
        key: "recent_asana_projects",
        value: normalizedProjects,
        confidence: 1
      }
    });
  }

  private async rememberRecentAsanaTeams(userId: string, teams: AsanaTeamSummary[]): Promise<void> {
    const normalizedTeams = teams.slice(0, 20).map((team) => ({
      teamGid: team.gid,
      name: team.name,
      workspaceGid: team.workspaceGid,
      workspaceName: team.workspaceName
    }));

    if (!normalizedTeams.length) return;

    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "recent_asana_teams" } },
      update: {
        value: normalizedTeams,
        confidence: 1
      },
      create: {
        userId,
        key: "recent_asana_teams",
        value: normalizedTeams,
        confidence: 1
      }
    });
  }

  private async rememberRecentAsanaProjectsFromTasks(
    userId: string,
    tasks: AsanaTaskSummary[]
  ): Promise<void> {
    const projects = tasks.flatMap((task) =>
      (task.projects ?? []).map((project) => ({
        gid: project.gid,
        name: project.name,
        workspaceGid: task.workspaceGid,
        workspaceName: task.workspaceName
      }))
    );

    await this.rememberRecentAsanaProjects(userId, projects);
  }

  private async getRecentAsanaWorkspace(userId: string): Promise<string | null> {
    const entry = await this.prisma.memoryEntry.findUnique({
      where: { userId_key: { userId, key: "recent_asana_workspace" } }
    });

    const workspaceGid =
      entry?.value &&
      typeof entry.value === "object" &&
      typeof (entry.value as { workspaceGid?: unknown }).workspaceGid === "string"
        ? (entry.value as { workspaceGid: string }).workspaceGid
        : null;

    return workspaceGid;
  }

  private async resolveAsanaWorkspace(
    userId: string,
    service: AsanaService,
    requestedWorkspaceGid?: string
  ): Promise<string> {
    if (requestedWorkspaceGid) {
      await this.rememberRecentAsanaWorkspace(userId, { workspaceGid: requestedWorkspaceGid });
      return requestedWorkspaceGid;
    }

    const recentWorkspace = await this.getRecentAsanaWorkspace(userId);
    if (recentWorkspace) return recentWorkspace;

    const workspaces = await service.listWorkspaces();
    if (workspaces.length === 1) {
      const workspace = workspaces[0];
      await this.rememberRecentAsanaWorkspace(userId, {
        workspaceGid: workspace!.gid,
        name: workspace!.name
      });
      return workspace!.gid;
    }

    if (!workspaces.length) {
      throw new UserFacingError(
        "No Asana workspaces found",
        "ASANA_NO_WORKSPACES",
        "I couldn't find any Asana workspaces on the connected account."
      );
    }

    throw new UserFacingError(
      "Asana workspace selection required",
      "ASANA_WORKSPACE_SELECTION_REQUIRED",
      "You have multiple Asana workspaces. Ask me to list Asana workspaces and pick one."
    );
  }

  private normalizeAsanaName(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, " ");
  }

  private looksLikeAsanaGid(value: string): boolean {
    return /^(?:\d{6,}|[a-z]+_\d+)$/i.test(value.trim());
  }

  private formatAsanaCandidates<T extends { gid: string; name: string }>(
    candidates: T[],
    idLabel: string
  ): string {
    return candidates
      .slice(0, 5)
      .map((candidate) => `- ${candidate.name} (${idLabel}: ${candidate.gid})`)
      .join("\n");
  }

  private pickUniqueByName<T extends { name: string }>(
    items: T[],
    requestedName: string
  ): T | null {
    const normalized = this.normalizeAsanaName(requestedName);
    const exactMatches = items.filter((item) => this.normalizeAsanaName(item.name) === normalized);
    if (exactMatches.length === 1) return exactMatches[0]!;
    if (exactMatches.length > 1) return null;

    const fuzzyMatches = items.filter((item) => {
      const name = this.normalizeAsanaName(item.name);
      return name.includes(normalized) || normalized.includes(name);
    });

    return fuzzyMatches.length === 1 ? fuzzyMatches[0]! : null;
  }

  private async resolveAsanaProjectGid(
    userId: string,
    service: AsanaService,
    input: { workspaceGid?: string; projectGid?: string; projectName?: string }
  ): Promise<string> {
    if (input.projectGid && this.looksLikeAsanaGid(input.projectGid)) {
      return input.projectGid;
    }

    const projectName = input.projectName ?? input.projectGid;
    if (!projectName) {
      throw new UserFacingError(
        "Asana project selection required",
        "ASANA_PROJECT_SELECTION_REQUIRED",
        "Tell me which Asana project to use."
      );
    }

    const workspaceGid = await this.resolveAsanaWorkspace(userId, service, input.workspaceGid);
    const projects = await service.listProjects(workspaceGid);
    await this.rememberRecentAsanaWorkspace(userId, { workspaceGid });
    await this.rememberRecentAsanaProjects(userId, projects);

    const normalizedProjectName = this.normalizeAsanaName(projectName);
    const exactMatches = projects.filter(
      (project) => this.normalizeAsanaName(project.name) === normalizedProjectName
    );
    if (exactMatches.length === 1) return exactMatches[0]!.gid;

    if (exactMatches.length > 1) {
      throw new UserFacingError(
        "Ambiguous Asana project",
        "ASANA_PROJECT_AMBIGUOUS",
        [
          `I found multiple Asana projects named "${projectName}".`,
          this.formatAsanaCandidates(exactMatches, "projectGid"),
          "Tell me which one to use."
        ].join("\n")
      );
    }

    const fuzzyMatches = projects.filter((project) => {
      const name = this.normalizeAsanaName(project.name);
      return name.includes(normalizedProjectName) || normalizedProjectName.includes(name);
    });
    if (fuzzyMatches.length === 1) return fuzzyMatches[0]!.gid;

    if (fuzzyMatches.length > 1) {
      throw new UserFacingError(
        "Ambiguous Asana project",
        "ASANA_PROJECT_AMBIGUOUS",
        [
          `I found multiple Asana projects matching "${projectName}".`,
          this.formatAsanaCandidates(fuzzyMatches, "projectGid"),
          "Tell me which one to use."
        ].join("\n")
      );
    }

    throw new UserFacingError(
      "Asana project not found",
      "ASANA_PROJECT_NOT_FOUND",
      `I couldn't find an Asana project named "${projectName}". Ask me to list Asana projects if you want to pick from them.`
    );
  }

  private async resolveAsanaProjectGids(
    userId: string,
    service: AsanaService,
    input: { workspaceGid?: string; projectGids?: string[]; projectNames?: string[] }
  ): Promise<string[] | undefined> {
    const projectInputs = [
      ...(input.projectGids ?? []).map((projectGid) => ({ projectGid })),
      ...(input.projectNames ?? []).map((projectName) => ({ projectName }))
    ];
    if (!projectInputs.length) return undefined;

    const resolved = await Promise.all(
      projectInputs.map((projectInput) =>
        this.resolveAsanaProjectGid(userId, service, {
          workspaceGid: input.workspaceGid,
          ...projectInput
        })
      )
    );

    return [...new Set(resolved)];
  }

  private async getRecentAsanaTasks(userId: string): Promise<AsanaTaskSummary[]> {
    const entry = await this.prisma.memoryEntry.findUnique({
      where: { userId_key: { userId, key: "recent_asana_tasks" } }
    });

    if (!Array.isArray(entry?.value)) return [];
    return entry.value
      .map((task) => {
        const value = task as { taskGid?: unknown; gid?: unknown; name?: unknown };
        const gid = typeof value.taskGid === "string" ? value.taskGid : value.gid;
        return typeof gid === "string" && typeof value.name === "string"
          ? ({
              ...value,
              gid,
              name: value.name
            } as AsanaTaskSummary)
          : null;
      })
      .filter((task): task is AsanaTaskSummary => Boolean(task));
  }

  private async resolveAsanaTaskGid(
    userId: string,
    service: AsanaService,
    input: { workspaceGid?: string; taskGid?: string; taskName?: string }
  ): Promise<string> {
    if (input.taskGid && this.looksLikeAsanaGid(input.taskGid)) {
      return input.taskGid;
    }

    const taskName = input.taskName ?? input.taskGid;
    if (!taskName) {
      throw new UserFacingError(
        "Asana task selection required",
        "ASANA_TASK_SELECTION_REQUIRED",
        "Tell me which Asana task to use."
      );
    }

    const recentTasks = await this.getRecentAsanaTasks(userId);
    const recentMatch = this.pickUniqueByName(recentTasks, taskName);
    if (recentMatch) return recentMatch.gid;

    const workspaceGid = await this.resolveAsanaWorkspace(userId, service, input.workspaceGid);
    const searchResults = await service.searchTasks({
      workspaceGid,
      text: taskName,
      limit: 10
    });
    await this.rememberRecentAsanaWorkspace(userId, { workspaceGid });
    if (searchResults.length) {
      await this.rememberRecentAsanaTasks(userId, searchResults);
    }

    const searchMatch = this.pickUniqueByName(searchResults, taskName);
    if (searchMatch) return searchMatch.gid;

    const normalizedTaskName = this.normalizeAsanaName(taskName);
    const candidates = searchResults.filter((task) => {
      const name = this.normalizeAsanaName(task.name);
      return name.includes(normalizedTaskName) || normalizedTaskName.includes(name);
    });

    if (candidates.length > 1) {
      throw new UserFacingError(
        "Ambiguous Asana task",
        "ASANA_TASK_AMBIGUOUS",
        [
          `I found multiple Asana tasks matching "${taskName}".`,
          this.formatAsanaCandidates(candidates, "taskGid"),
          "Tell me which one to use."
        ].join("\n")
      );
    }

    throw new UserFacingError(
      "Asana task not found",
      "ASANA_TASK_NOT_FOUND",
      `I couldn't find an Asana task named "${taskName}". Ask me to list recent Asana tasks if you want to pick from them.`
    );
  }

  async executeToolCall(
    toolNameValue: string,
    rawInput: unknown,
    context: ToolExecutionContext,
    options: { force?: boolean } = {}
  ): Promise<ToolExecutionResult> {
    if (!isToolName(toolNameValue)) {
      return {
        ok: false,
        error: `Unknown tool: ${toolNameValue}`,
        userMessage: "I could not use that tool."
      };
    }

    const toolName = toolNameValue;
    let parsedInput = this.validateInput(toolName, rawInput);
    parsedInput = normalizeAsanaWriteInput(toolName, parsedInput, context.latestUserMessage);
    parsedInput = normalizeAutomationCreateInput(toolName, parsedInput, context.user.timezone);

    if (env.READ_ONLY_MODE && isWriteTool(toolName)) {
      await this.audit.log({
        userId: context.user.id,
        actionType: "write_blocked_read_only",
        toolName,
        requestPayload: parsedInput,
        status: "blocked"
      });
      return {
        ok: false,
        error: "WRITE_DISABLED",
        userMessage: "Write actions are disabled in read-only mode."
      };
    }

    if (!options.force) {
      const approval = getApprovalDecision(toolName, parsedInput, context.latestUserMessage);
      if (approval.requiresApproval && approval.confirmationKeyword) {
        await createPendingAction(this.prisma, {
          userId: context.user.id,
          conversationId: context.conversation.id,
          actionType: toolName,
          payload: {
            toolName,
            input: parsedInput,
            confirmationKeyword: approval.confirmationKeyword,
            summary: approval.reason
          }
        });

        await this.audit.log({
          userId: context.user.id,
          actionType: approval.reason ?? "pending_approval",
          toolName,
          requestPayload: parsedInput,
          status: "pending"
        });

        return {
          ok: true,
          approvalRequired: true,
          data: { pending: true, toolName },
          userMessage: approval.confirmationMessage
        };
      }
    }

    return this.executeValidatedTool(toolName, parsedInput, context);
  }

  async executePendingAction(
    pendingAction: PendingAction,
    context: ToolExecutionContext,
    intent: "SEND" | "CONFIRM"
  ): Promise<ToolExecutionResult> {
    const expected = expectedConfirmationForPayload(pendingAction.payload);
    if (!matchesPositiveConfirmation(intent, expected)) {
      return {
        ok: false,
        userMessage: "Reply yes to approve it, or CANCEL to cancel it."
      };
    }

    const payload = pendingAction.payload as unknown as PendingToolPayload;
    if (!payload.toolName || !isToolName(payload.toolName)) {
      await this.prisma.pendingAction.update({
        where: { id: pendingAction.id },
        data: { status: PendingActionStatus.FAILED }
      });
      return { ok: false, userMessage: "I could not read that pending action." };
    }

    await this.prisma.pendingAction.update({
      where: { id: pendingAction.id },
      data: { status: PendingActionStatus.APPROVED }
    });

    const result = await this.executeToolCall(payload.toolName, payload.input, context, {
      force: true
    });

    await this.prisma.pendingAction.update({
      where: { id: pendingAction.id },
      data: {
        status: result.ok ? PendingActionStatus.EXECUTED : PendingActionStatus.FAILED
      }
    });

    return result;
  }

  private validateInput(toolName: ToolName, rawInput: unknown): any {
    return toolInputSchemas[toolName].parse(rawInput);
  }

  private async executeValidatedTool(
    toolName: ToolName,
    input: any,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    try {
      if (toolName === "web_search") {
        const service = new WebSearchService();
        const data = await service.search(input.query, input.allowedDomains);
        return { ok: true, data };
      }

      if (toolName.startsWith("automation_")) {
        if (toolName === "automation_create") {
          const data = await this.automationService.createAutomation({
            userId: context.user.id,
            conversationId: context.conversation.id,
            name: input.name,
            prompt: input.prompt,
            schedule: input.schedule,
            timezone: input.timezone,
            now: new Date()
          });
          await this.audit.log({
            userId: context.user.id,
            actionType: "automation_create",
            toolName,
            requestPayload: input,
            responsePayload: summarizeAutomation(data),
            status: "executed"
          });
          return {
            ok: true,
            data: summarizeAutomation(data),
            userMessage: formatAutomationCreated(data),
            stopAfterTool: true
          };
        }

        if (toolName === "automation_list") {
          const data = await this.automationService.listAutomations(context.user.id);
          await this.automationService.rememberRecentAutomations(context.user.id, data);
          return {
            ok: true,
            data,
            userMessage: formatAutomationList(data, context.user.timezone, {
              runnerEnabled: env.AUTOMATION_RUNNER_ENABLED
            }),
            stopAfterTool: true
          };
        }

        if (toolName === "automation_pause") {
          const data = await this.automationService.pauseAutomation(context.user.id, input);
          await this.audit.log({
            userId: context.user.id,
            actionType: "automation_pause",
            toolName,
            requestPayload: input,
            responsePayload: summarizeAutomation(data),
            status: "executed"
          });
          return {
            ok: true,
            data: summarizeAutomation(data),
            userMessage: `Paused automation: ${data.name}.`,
            stopAfterTool: true
          };
        }

        if (toolName === "automation_resume") {
          const data = await this.automationService.resumeAutomation(context.user.id, input);
          await this.audit.log({
            userId: context.user.id,
            actionType: "automation_resume",
            toolName,
            requestPayload: input,
            responsePayload: summarizeAutomation(data),
            status: "executed"
          });
          return {
            ok: true,
            data: summarizeAutomation(data),
            userMessage: `Resumed automation: ${data.name}. Next run: ${formatForUser(
              data.nextRunAt,
              data.timezone
            )}.`,
            stopAfterTool: true
          };
        }

        if (toolName === "automation_delete") {
          const data = await this.automationService.deleteAutomation(context.user.id, input);
          await this.audit.log({
            userId: context.user.id,
            actionType: "automation_delete",
            toolName,
            requestPayload: input,
            responsePayload: summarizeAutomation(data),
            status: "executed"
          });
          return {
            ok: true,
            data: summarizeAutomation(data),
            userMessage: `Deleted automation: ${data.name}.`,
            stopAfterTool: true
          };
        }
      }

      if (toolName.startsWith("notion_")) {
        const accessToken = await this.notionTokenService.getAccessTokenForUser(context.user);
        const service = new NotionService(accessToken);

        if (toolName === "notion_search_pages") {
          const data = await service.searchPages(input.query, input.limit);
          await this.rememberRecentNotionPages(context.user.id, data);
          if (data.length === 1) {
            await this.rememberRecentNotionPage(context.user.id, data[0]!);
          }
          return { ok: true, data };
        }

        if (toolName === "notion_read_page") {
          const data = await service.readPage(input.pageId);
          await this.rememberRecentNotionPage(context.user.id, data);
          return { ok: true, data };
        }

        if (toolName === "notion_create_page") {
          const data = await service.createPage(input);
          await this.rememberRecentNotionPage(context.user.id, data);
          await this.audit.log({
            userId: context.user.id,
            actionType: "notion_create_page",
            toolName,
            requestPayload: input,
            responsePayload: data,
            status: "executed"
          });
          return {
            ok: true,
            data,
            userMessage: `Created: ${data.title}${data.url ? `\n${data.url}` : ""}`
          };
        }

        if (toolName === "notion_append_page") {
          const data = await service.appendToPage(input);
          await this.rememberRecentNotionPage(context.user.id, data);
          await this.audit.log({
            userId: context.user.id,
            actionType: "notion_append_page",
            toolName,
            requestPayload: input,
            responsePayload: data,
            status: "executed"
          });
          return {
            ok: true,
            data,
            userMessage: `Updated: ${data.title}${data.url ? `\n${data.url}` : ""}`
          };
        }

        if (toolName === "notion_update_page_title") {
          const data = await service.updatePageTitle(input);
          await this.rememberRecentNotionPage(context.user.id, data);
          await this.audit.log({
            userId: context.user.id,
            actionType: "notion_update_page_title",
            toolName,
            requestPayload: input,
            responsePayload: data,
            status: "executed"
          });
          return {
            ok: true,
            data,
            userMessage: `Renamed: ${data.title}${data.url ? `\n${data.url}` : ""}`
          };
        }
      }

      if (toolName.startsWith("asana_")) {
        const accessToken = await this.asanaTokenService.getAccessTokenForUser(context.user, {
          requiredScopes:
            toolName === "asana_list_workspaces"
              ? ["workspaces:read"]
              : toolName === "asana_list_projects"
                ? ["projects:read", "workspaces:read", "teams:read"]
                : toolName === "asana_list_teams"
                  ? ["teams:read", "workspaces:read"]
                  : toolName === "asana_list_users"
                    ? ["users:read", "workspaces:read"]
                    : toolName === "asana_list_project_tasks" || toolName === "asana_search_tasks"
                      ? ["tasks:read", "projects:read", "workspaces:read"]
                      : toolName === "asana_delete_task"
                        ? ["tasks:delete", "tasks:read", "workspaces:read"]
                        : toolName === "asana_bulk_update_tasks"
                          ? ["tasks:write", "tasks:read"]
                          : toolName === "asana_create_task" || toolName === "asana_update_task"
                            ? ["tasks:write", "tasks:read", "projects:read", "workspaces:read"]
                            : ["tasks:read", "workspaces:read"],
          reconnectReason:
            toolName === "asana_create_task" ||
            toolName === "asana_update_task" ||
            toolName === "asana_delete_task" ||
            toolName === "asana_bulk_update_tasks"
              ? "Reconnect your Asana account to manage tasks"
              : "Reconnect your Asana account to read tasks"
        });

        const service = new AsanaService(accessToken);

        if (toolName === "asana_list_workspaces") {
          const data = await service.listWorkspaces();
          if (data.length === 1) {
            const workspace = data[0];
            await this.rememberRecentAsanaWorkspace(context.user.id, {
              workspaceGid: workspace!.gid,
              name: workspace!.name
            });
          }
          return { ok: true, data };
        }

        if (toolName === "asana_list_projects") {
          const workspaceGid = await this.resolveAsanaWorkspace(
            context.user.id,
            service,
            input.workspaceGid
          );
          await this.rememberRecentAsanaWorkspace(context.user.id, {
            workspaceGid
          });
          const data = await service.listProjects(workspaceGid, input.query);
          await this.rememberRecentAsanaProjects(context.user.id, data);
          await this.rememberRecentAsanaTeams(
            context.user.id,
            Array.from(
              new Map(
                data
                  .filter((project) => project.teamGid)
                  .map((project) => [
                    project.teamGid!,
                    {
                      gid: project.teamGid!,
                      name: project.teamName ?? "(Untitled team)",
                      workspaceGid: project.workspaceGid,
                      workspaceName: project.workspaceName
                    } satisfies AsanaTeamSummary
                  ])
              ).values()
            )
          );
          return { ok: true, data };
        }

        if (toolName === "asana_list_teams") {
          const workspaceGid = await this.resolveAsanaWorkspace(
            context.user.id,
            service,
            input.workspaceGid
          );
          await this.rememberRecentAsanaWorkspace(context.user.id, {
            workspaceGid
          });
          const data = await service.listTeams(workspaceGid, input.query);
          await this.rememberRecentAsanaTeams(context.user.id, data);
          return { ok: true, data };
        }

        if (toolName === "asana_list_users") {
          const workspaceGid = await this.resolveAsanaWorkspace(
            context.user.id,
            service,
            input.workspaceGid
          );
          await this.rememberRecentAsanaWorkspace(context.user.id, {
            workspaceGid
          });
          const data = await service.listUsers(workspaceGid, input.query);
          return { ok: true, data };
        }

        if (toolName === "asana_list_my_tasks") {
          const workspaceGid = await this.resolveAsanaWorkspace(
            context.user.id,
            service,
            input.workspaceGid
          );
          const data = await service.listMyTasks({
            ...input,
            workspaceGid
          });
          if (workspaceGid) {
            await this.rememberRecentAsanaWorkspace(context.user.id, { workspaceGid });
          }
          if (data.length) {
            const firstTask = data[0];
            await this.rememberRecentAsanaTasks(context.user.id, data);
            await this.rememberRecentAsanaProjectsFromTasks(context.user.id, data);
            if (firstTask?.workspaceGid) {
              await this.rememberRecentAsanaWorkspace(context.user.id, {
                workspaceGid: firstTask.workspaceGid,
                name: firstTask.workspaceName
              });
            }
          }
          return { ok: true, data };
        }

        if (toolName === "asana_list_project_tasks") {
          const projectGid = await this.resolveAsanaProjectGid(context.user.id, service, {
            workspaceGid: input.workspaceGid,
            projectGid: input.projectGid,
            projectName: input.projectName
          });
          const data = await service.listProjectTasks({
            projectGid,
            completed: input.completed,
            dueOn: input.dueOn,
            dueBefore: input.dueBefore,
            limit: input.limit,
            sortBy: input.sortBy,
            sortDirection: input.sortDirection
          });
          if (data.length) {
            const firstTask = data[0];
            await this.rememberRecentAsanaTasks(context.user.id, data);
            await this.rememberRecentAsanaProjectsFromTasks(context.user.id, data);
            if (firstTask?.workspaceGid) {
              await this.rememberRecentAsanaWorkspace(context.user.id, {
                workspaceGid: firstTask.workspaceGid,
                name: firstTask.workspaceName
              });
            }
          }
          return { ok: true, data };
        }

        if (toolName === "asana_search_tasks") {
          const workspaceGid = await this.resolveAsanaWorkspace(
            context.user.id,
            service,
            input.workspaceGid
          );
          const projectGid =
            input.projectName || input.projectGid
              ? await this.resolveAsanaProjectGid(context.user.id, service, {
                  workspaceGid,
                  projectGid: input.projectGid,
                  projectName: input.projectName
                })
              : undefined;
          const data = await service.searchTasks({
            ...input,
            workspaceGid,
            projectGid
          });
          await this.rememberRecentAsanaWorkspace(context.user.id, { workspaceGid });
          if (data.length) {
            await this.rememberRecentAsanaTasks(context.user.id, data);
            await this.rememberRecentAsanaProjectsFromTasks(context.user.id, data);
          }
          return { ok: true, data };
        }

        if (toolName === "asana_get_task") {
          const data = await service.getTask(input.taskGid);
          await this.rememberRecentAsanaTasks(context.user.id, [data]);
          await this.rememberRecentAsanaProjectsFromTasks(context.user.id, [data]);
          if (data.workspaceGid) {
            await this.rememberRecentAsanaWorkspace(context.user.id, {
              workspaceGid: data.workspaceGid,
              name: data.workspaceName
            });
          }
          return { ok: true, data };
        }

        if (toolName === "asana_create_task") {
          const projectGids = await this.resolveAsanaProjectGids(context.user.id, service, {
            workspaceGid: input.workspaceGid,
            projectGids: input.projectGids,
            projectNames: input.projectNames
          });
          const workspaceGid =
            input.workspaceGid || !projectGids?.length
              ? await this.resolveAsanaWorkspace(context.user.id, service, input.workspaceGid)
              : undefined;
          const data = await service.createTask({
            ...input,
            workspaceGid,
            projectGids
          });
          await this.rememberRecentAsanaTasks(context.user.id, [data]);
          await this.rememberRecentAsanaProjectsFromTasks(context.user.id, [data]);
          const rememberedWorkspaceGid = data.workspaceGid ?? workspaceGid;
          if (rememberedWorkspaceGid) {
            await this.rememberRecentAsanaWorkspace(context.user.id, {
              workspaceGid: rememberedWorkspaceGid,
              name: data.workspaceName
            });
          }
          await this.audit.log({
            userId: context.user.id,
            actionType: "asana_create_task",
            toolName,
            requestPayload: input,
            responsePayload: data,
            status: "executed"
          });
          return { ok: true, data };
        }

        if (toolName === "asana_update_task") {
          const taskGid = await this.resolveAsanaTaskGid(context.user.id, service, {
            workspaceGid: input.workspaceGid,
            taskGid: input.taskGid,
            taskName: input.taskName
          });
          const data = await service.updateTask({
            taskGid,
            name: input.name,
            notes: input.notes,
            dueOn: input.dueOn,
            dueAt: input.dueAt,
            assigneeGid: input.assigneeGid,
            completed: input.completed
          });
          await this.rememberRecentAsanaTasks(context.user.id, [data]);
          await this.rememberRecentAsanaProjectsFromTasks(context.user.id, [data]);
          if (data.workspaceGid) {
            await this.rememberRecentAsanaWorkspace(context.user.id, {
              workspaceGid: data.workspaceGid,
              name: data.workspaceName
            });
          }
          await this.audit.log({
            userId: context.user.id,
            actionType: "asana_update_task",
            toolName,
            requestPayload: input,
            responsePayload: data,
            status: "executed"
          });
          return { ok: true, data };
        }

        if (toolName === "asana_delete_task") {
          const taskGid = await this.resolveAsanaTaskGid(context.user.id, service, {
            workspaceGid: input.workspaceGid,
            taskGid: input.taskGid,
            taskName: input.taskName
          });
          const data = await service.deleteTask(taskGid);
          await this.audit.log({
            userId: context.user.id,
            actionType: "asana_delete_task",
            toolName,
            requestPayload: input,
            responsePayload: data,
            status: "executed"
          });
          return { ok: true, data, userMessage: data.summary };
        }

        if (toolName === "asana_bulk_update_tasks") {
          const updated: AsanaTaskSummary[] = [];
          const failed: Array<{ taskGid: string; error: string }> = [];

          for (const taskGid of input.taskGids) {
            try {
              const task = await service.updateTask({ taskGid, completed: true });
              updated.push(task);
            } catch (error) {
              failed.push({ taskGid, error: serializeError(error) });
            }
          }

          if (updated.length) {
            await this.rememberRecentAsanaTasks(context.user.id, updated);
          }

          const data = {
            updated,
            failed,
            summary: `Completed ${updated.length} Asana task${updated.length === 1 ? "" : "s"}${failed.length ? `; ${failed.length} failed` : ""}.`
          };

          await this.audit.log({
            userId: context.user.id,
            actionType: "asana_bulk_update_tasks",
            toolName,
            requestPayload: input,
            responsePayload: data,
            status: failed.length ? "failed" : "executed"
          });

          return {
            ok: failed.length === 0,
            data,
            userMessage: data.summary
          };
        }
      }

      const auth = await this.googleTokenService.getOAuthClientForUser(
        context.user,
        googleAuthRequirements(toolName, input)
      );

      if (toolName === "gmail_search_threads") {
        const service = new GmailService(auth);
        const data = await service.searchThreads(input.query, input.maxResults);
        await this.rememberRecentGmailThreads(context.user.id, data);
        return { ok: true, data };
      }

      if (toolName === "gmail_read_thread") {
        const service = new GmailService(auth);
        const data = await service.readThread(input.threadId);
        await this.rememberRecentGmailThreadMessages(context.user.id, data);
        return { ok: true, data };
      }

      if (toolName === "gmail_create_draft") {
        const service = new GmailService(auth);
        const data = await service.createDraft(input);
        await this.audit.log({
          userId: context.user.id,
          actionType: "gmail_create_draft",
          toolName,
          requestPayload: input,
          responsePayload: data,
          status: "success"
        });

        await this.prisma.pendingAction.updateMany({
          where: {
            userId: context.user.id,
            conversationId: context.conversation.id,
            actionType: "gmail_send_draft",
            status: PendingActionStatus.PENDING
          },
          data: { status: PendingActionStatus.CANCELLED }
        });

        await createPendingAction(this.prisma, {
          userId: context.user.id,
          conversationId: context.conversation.id,
          actionType: "gmail_send_draft",
          payload: {
            toolName: "gmail_send_draft",
            input: { draftId: data.draftId },
            confirmationKeyword: "SEND",
            summary: data.summary,
            context: {
              to: data.to,
              subject: data.subject,
              body: input.body
            }
          }
        });

        return {
          ok: true,
          data,
          userMessage: [
            "Draft ready.",
            "",
            `To: ${data.to}`,
            `Subject: ${data.subject}`,
            "",
            input.body,
            "",
            "Reply send to send it, or tell me what to tweak."
          ].join("\n"),
          stopAfterTool: true
        };
      }

      if (toolName === "gmail_send_draft") {
        const service = new GmailService(auth);
        const data = await service.sendDraft(input.draftId);
        await this.audit.log({
          userId: context.user.id,
          actionType: "gmail_send_draft",
          toolName,
          requestPayload: input,
          responsePayload: data,
          status: "executed"
        });
        return { ok: true, data, userMessage: "Sent the draft." };
      }

      if (toolName === "gmail_trash_thread") {
        const service = new GmailService(auth);
        const data = await service.trashThread(input.threadId);
        await this.audit.log({
          userId: context.user.id,
          actionType: "gmail_trash_thread",
          toolName,
          requestPayload: input,
          responsePayload: data,
          status: "executed"
        });
        return { ok: true, data, userMessage: data.summary };
      }

      if (toolName === "calendar_list_calendars") {
        const service = new CalendarService(auth);
        const data = await service.listCalendars();
        await this.rememberRecentCalendars(context.user.id, data);
        return { ok: true, data };
      }

      if (toolName === "calendar_list_events") {
        const service = new CalendarService(auth);
        const rawData = await service.listEvents(input);
        const data = input.calendarId
          ? rawData
          : await this.applyCalendarExclusions(context.user.id, rawData);
        await this.rememberRecentCalendarEvents(context.user.id, data);
        return { ok: true, data };
      }

      if (toolName === "calendar_create_event") {
        const service = new CalendarService(auth);
        const data = await service.createEvent(input);
        await this.rememberRecentCalendarEvents(context.user.id, [data]);
        await this.audit.log({
          userId: context.user.id,
          actionType: "calendar_create_event",
          toolName,
          requestPayload: input,
          responsePayload: data,
          status: "executed"
        });
        return {
          ok: true,
          data,
          userMessage: `Booked: ${data.title}${data.start ? ` at ${formatForUser(data.start, context.user.timezone)}` : ""}.`
        };
      }

      if (toolName === "calendar_update_event") {
        const service = new CalendarService(auth);
        const data = await service.updateEvent(input);
        await this.rememberRecentCalendarEvents(context.user.id, [data]);
        await this.audit.log({
          userId: context.user.id,
          actionType: "calendar_update_event",
          toolName,
          requestPayload: input,
          responsePayload: data,
          status: "executed"
        });
        return {
          ok: true,
          data,
          userMessage: `Updated: ${data.title}${data.start ? ` at ${formatForUser(data.start, context.user.timezone)}` : ""}.`
        };
      }

      if (toolName === "calendar_delete_event") {
        const service = new CalendarService(auth);
        const data = await service.deleteEvent(input);
        await this.audit.log({
          userId: context.user.id,
          actionType: "calendar_delete_event",
          toolName,
          requestPayload: input,
          responsePayload: data,
          status: "executed"
        });
        return { ok: true, data, userMessage: data.summary };
      }

      if (toolName === "drive_search_files") {
        const service = new DriveService(auth);
        const data = await service.searchFiles(input);
        await this.rememberRecentDriveFiles(context.user.id, data);
        await this.rememberRecentGoogleDocFromDriveFiles(context.user.id, data);
        return { ok: true, data };
      }

      if (toolName === "drive_read_file_metadata") {
        const service = new DriveService(auth);
        const data = await service.readFileMetadata(input.fileId);
        await this.rememberRecentDriveFiles(context.user.id, [data]);
        await this.rememberRecentGoogleDocFromDriveFiles(context.user.id, [data]);
        return { ok: true, data };
      }

      if (toolName === "drive_delete_file") {
        const service = new DriveService(auth);
        const data = await service.deleteFile(input.fileId);
        await this.audit.log({
          userId: context.user.id,
          actionType: "drive_delete_file",
          toolName,
          requestPayload: input,
          responsePayload: data,
          status: "executed"
        });
        await this.forgetRecentGoogleDocIfDeleted(context.user.id, input.fileId);
        return { ok: true, data, userMessage: data.summary };
      }

      if (toolName === "docs_read_document") {
        const service = new DocsService(auth);
        const data = await service.readDocument(input.documentId);
        await this.rememberRecentDocument(context.user.id, data);
        return { ok: true, data };
      }

      if (toolName === "docs_append_document") {
        const service = new DocsService(auth);
        const data = await service.appendToDocument(input);
        await this.rememberRecentDocument(context.user.id, data);
        await this.audit.log({
          userId: context.user.id,
          actionType: "docs_append_document",
          toolName,
          requestPayload: input,
          responsePayload: data,
          status: "executed"
        });
        return { ok: true, data, userMessage: `Updated: ${data.title}\n${data.url}` };
      }

      if (toolName === "docs_create_document") {
        const service = new DocsService(auth);
        const data = await service.createDocument(input);
        await this.rememberRecentDocument(context.user.id, data);
        await this.audit.log({
          userId: context.user.id,
          actionType: "docs_create_document",
          toolName,
          requestPayload: input,
          responsePayload: data,
          status: "executed"
        });
        return { ok: true, data, userMessage: `Created: ${data.title}\n${data.url}` };
      }

      return { ok: false, error: `Unhandled tool: ${toolName}` };
    } catch (error) {
      if (isWriteTool(toolName)) {
        await this.audit.log({
          userId: context.user.id,
          actionType: toolName,
          toolName,
          requestPayload: input,
          status: "failed",
          error: serializeError(error)
        });
      }

      const defaultMessage =
        userMessageForError(error) === "I hit a problem handling that. Please try again."
          ? defaultToolFailureMessage(toolName)
          : userMessageForError(error);

      return {
        ok: false,
        error: serializeError(error),
        userMessage: defaultMessage
      };
    }
  }
}

function defaultToolFailureMessage(toolName: ToolName): string {
  if (toolName.startsWith("asana_")) {
    return "I couldn't complete that Asana request right now. Try again in a moment.";
  }
  if (toolName.startsWith("calendar_")) {
    return "I couldn't complete that calendar request right now. Try again in a moment.";
  }
  if (toolName.startsWith("gmail_")) {
    return "I couldn't complete that Gmail request right now. Try again in a moment.";
  }
  if (toolName.startsWith("drive_")) {
    return "I couldn't complete that Drive request right now. Try again in a moment.";
  }
  if (toolName.startsWith("docs_")) {
    return "I couldn't complete that Google Doc request right now. Try again in a moment.";
  }
  if (toolName.startsWith("notion_")) {
    return "I couldn't complete that Notion request right now. Try again in a moment.";
  }
  if (toolName.startsWith("automation_")) {
    return "I couldn't complete that automation request right now. Try again in a moment.";
  }
  if (toolName === "web_search") {
    return "I couldn't complete that web lookup right now. Try again in a moment.";
  }
  return "I hit a problem handling that. Please try again.";
}

function googleAuthRequirements(
  toolName: ToolName,
  input: any
): { requiredScopes?: string[]; reconnectReason?: string } {
  if (toolName === "gmail_search_threads" || toolName === "gmail_read_thread") {
    return {
      requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      reconnectReason: "Reconnect your Google account to read Gmail"
    };
  }

  if (toolName === "gmail_create_draft") {
    return {
      requiredScopes: ["https://www.googleapis.com/auth/gmail.compose"],
      reconnectReason: "Reconnect your Google account to create Gmail drafts"
    };
  }

  if (toolName === "gmail_send_draft") {
    return {
      requiredScopes: ["https://www.googleapis.com/auth/gmail.send"],
      reconnectReason: "Reconnect your Google account to send Gmail drafts"
    };
  }

  if (toolName === "gmail_trash_thread") {
    return {
      requiredScopes: ["https://www.googleapis.com/auth/gmail.modify"],
      reconnectReason: "Reconnect your Google account to modify Gmail"
    };
  }

  if (toolName === "calendar_list_calendars" || toolName === "calendar_list_events") {
    return {
      requiredScopes: [
        input.calendarId
          ? "https://www.googleapis.com/auth/calendar.readonly"
          : "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
      ],
      reconnectReason: input.calendarId
        ? "Reconnect your Google account to read Google Calendar"
        : "Reconnect your Google account to access all of your calendars by name"
    };
  }

  if (
    toolName === "calendar_create_event" ||
    toolName === "calendar_update_event" ||
    toolName === "calendar_delete_event"
  ) {
    return {
      requiredScopes: ["https://www.googleapis.com/auth/calendar.events"],
      reconnectReason: "Reconnect your Google account to manage Google Calendar events"
    };
  }

  if (toolName === "drive_delete_file") {
    return {
      requiredScopes: ["https://www.googleapis.com/auth/drive"],
      reconnectReason: "Reconnect your Google account to delete Drive files"
    };
  }

  return {};
}
