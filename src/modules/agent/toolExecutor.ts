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
import type { AsanaTaskSummary, AsanaTeamSummary } from "../asana/asanaTypes";
import { CalendarService } from "../google/calendarService";
import { DocsService } from "../google/docsService";
import { DriveService } from "../google/driveService";
import { GmailService } from "../google/gmailService";
import { GoogleTokenService } from "../google/tokenService";
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

export class ToolExecutor {
  private readonly audit: AuditService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly googleTokenService: GoogleTokenService,
    private readonly asanaTokenService: AsanaTokenService
  ) {
    this.audit = new AuditService(prisma);
  }

  private async rememberRecentDocument(
    userId: string,
    document: { documentId: string; title: string; url: string }
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

    if (!normalizedEvents.length) return;

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

  private async rememberRecentDriveFiles(
    userId: string,
    files: DriveFileSummary[]
  ): Promise<void> {
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

  private async rememberRecentAsanaTasks(
    userId: string,
    tasks: AsanaTaskSummary[]
  ): Promise<void> {
    const normalizedTasks = tasks.slice(0, 10).map((task) => ({
      taskGid: task.gid,
      name: task.name,
      completed: task.completed,
      dueOn: task.dueOn,
      dueAt: task.dueAt,
      assigneeGid: task.assigneeGid,
      assigneeName: task.assigneeName,
      workspaceGid: task.workspaceGid,
      workspaceName: task.workspaceName,
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
    projects: Array<{
      gid: string;
      name?: string;
      workspaceGid?: string;
      workspaceName?: string;
      teamGid?: string;
      teamName?: string;
    }>
  ): Promise<void> {
    const normalizedProjects = Array.from(
      new Map(
        projects
          .filter((project) => project.gid)
          .slice(0, 20)
          .map((project) => [
            project.gid,
            {
              projectGid: project.gid,
              name: project.name ?? "(Untitled project)",
              workspaceGid: project.workspaceGid,
              workspaceName: project.workspaceName,
              teamGid: project.teamGid,
              teamName: project.teamName
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

  private async rememberRecentAsanaTeams(
    userId: string,
    teams: AsanaTeamSummary[]
  ): Promise<void> {
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
    const parsedInput = this.validateInput(toolName, rawInput);

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
                  : toolName === "asana_list_project_tasks"
                    ? ["tasks:read", "projects:read"]
                  : toolName === "asana_delete_task"
                    ? ["tasks:delete", "tasks:read"]
                  : toolName === "asana_create_task" || toolName === "asana_update_task"
                    ? ["tasks:write"]
                    : ["tasks:read"],
          reconnectReason:
            toolName === "asana_create_task" ||
            toolName === "asana_update_task" ||
            toolName === "asana_delete_task"
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
          await this.rememberRecentAsanaWorkspace(context.user.id, {
            workspaceGid: input.workspaceGid
          });
          const data = await service.listProjects(input.workspaceGid, input.query);
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
          await this.rememberRecentAsanaWorkspace(context.user.id, {
            workspaceGid: input.workspaceGid
          });
          const data = await service.listTeams(input.workspaceGid, input.query);
          await this.rememberRecentAsanaTeams(context.user.id, data);
          return { ok: true, data };
        }

        if (toolName === "asana_list_users") {
          await this.rememberRecentAsanaWorkspace(context.user.id, {
            workspaceGid: input.workspaceGid
          });
          const data = await service.listUsers(input.workspaceGid, input.query);
          return { ok: true, data };
        }

        if (toolName === "asana_list_my_tasks") {
          const workspaceGid = input.projectGid
            ? undefined
            : await this.resolveAsanaWorkspace(context.user.id, service, input.workspaceGid);
          const data = input.projectGid
            ? await service.listProjectTasks({
                projectGid: input.projectGid,
                completed: input.completed,
                dueOn: input.dueOn,
                dueBefore: input.dueBefore,
                limit: input.limit
              })
            : await service.listMyTasks({
                workspaceGid: workspaceGid!,
                completed: input.completed,
                dueOn: input.dueOn,
                dueBefore: input.dueBefore,
                limit: input.limit
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
          const data = await service.listProjectTasks(input);
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
          const data = await service.searchTasks({
            ...input,
            workspaceGid
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
          const workspaceGid =
            input.workspaceGid || !(input.projectGids?.length)
              ? await this.resolveAsanaWorkspace(context.user.id, service, input.workspaceGid)
              : undefined;
          const data = await service.createTask({
            ...input,
            workspaceGid
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
          const data = await service.updateTask(input);
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
          const data = await service.deleteTask(input.taskGid);
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
      }

      const auth = await this.googleTokenService.getOAuthClientForUser(context.user, {
        requiredScopes:
          toolName === "calendar_list_calendars" ||
          (toolName === "calendar_list_events" && !input.calendarId)
            ? ["https://www.googleapis.com/auth/calendar.calendarlist.readonly"]
            : toolName === "drive_delete_file"
              ? ["https://www.googleapis.com/auth/drive"]
              : [],
        reconnectReason:
          toolName === "drive_delete_file"
            ? "Reconnect your Google account to delete Drive files"
            : "Reconnect your Google account to access all of your calendars by name"
      });

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
        const data = await service.listEvents(input);
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
        return { ok: true, data };
      }

      if (toolName === "drive_read_file_metadata") {
        const service = new DriveService(auth);
        const data = await service.readFileMetadata(input.fileId);
        await this.rememberRecentDriveFiles(context.user.id, [data]);
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
  if (toolName === "web_search") {
    return "I couldn't complete that web lookup right now. Try again in a moment.";
  }
  return "I hit a problem handling that. Please try again.";
}
