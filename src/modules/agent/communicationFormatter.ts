import type {
  AsanaProjectSummary,
  AsanaTaskDetail,
  AsanaTaskSummary,
  AsanaTeamSummary,
  AsanaUserSummary,
  AsanaWorkspaceSummary
} from "../asana/asanaTypes";
import type {
  CalendarEventSummary,
  CalendarSummary,
  CreatedDocResult,
  DriveFileSummary,
  GmailThreadMessage,
  GmailThreadSummary,
  ReadDocResult,
  UpdatedDocResult,
  WebSearchResult
} from "../google/googleTypes";
import type { ToolExecutionResult } from "./toolExecutor";

interface ReferenceEntity {
  kind: string;
  id: string;
  name?: string;
  secondaryId?: string;
}

interface CommunicationEnvelope {
  app: string;
  outcome: "read_result" | "write_complete" | "empty";
  summary: string;
  nextStep?: string;
  referenceEntities: ReferenceEntity[];
}

export function formatToolResultForModel(
  toolName: string,
  result: ToolExecutionResult
): Record<string, unknown> {
  if (!result.ok) {
    return {
      ok: result.ok,
      error: result.error,
      userMessage: result.userMessage
    };
  }

  const communication = buildCommunicationEnvelope(toolName, result);

  return {
    ok: result.ok,
    communication,
    data: result.data
  };
}

function buildCommunicationEnvelope(
  toolName: string,
  result: ToolExecutionResult
): CommunicationEnvelope {
  if (toolName === "docs_create_document" || toolName === "docs_append_document") {
    const doc = result.data as CreatedDocResult | UpdatedDocResult | undefined;
    return {
      app: "docs",
      outcome: "write_complete",
      summary:
        toolName === "docs_create_document"
          ? `Created Google Doc: ${doc?.title ?? "Untitled"}.`
          : `Updated Google Doc: ${doc?.title ?? "Untitled"}.`,
      nextStep: doc?.documentId ? "You can ask me to append more or summarize it." : undefined,
      referenceEntities: doc?.documentId
        ? [
            {
              kind: "google_doc",
              id: doc.documentId,
              name: doc.title
            }
          ]
        : []
    };
  }

  if (result.userMessage) {
    return {
      app: inferApp(toolName),
      outcome: "write_complete",
      summary: result.userMessage,
      nextStep: writeNextStep(toolName),
      referenceEntities: referenceEntitiesFromData(toolName, result.data)
    };
  }

  if (toolName === "gmail_search_threads") {
    const threads = asArray<GmailThreadSummary>(result.data);
    return {
      app: "gmail",
      outcome: threads.length ? "read_result" : "empty",
      summary: threads.length
        ? `Found ${threads.length} Gmail ${threads.length === 1 ? "thread" : "threads"}.`
        : "No Gmail threads matched that search.",
      nextStep: threads.length
        ? "You can ask me to read one or trash one."
        : "You can try a different Gmail search.",
      referenceEntities: threads.slice(0, 10).map((thread) => ({
        kind: "gmail_thread",
        id: thread.threadId,
        name: thread.subject ?? "No subject"
      }))
    };
  }

  if (toolName === "gmail_read_thread") {
    const messages = asArray<GmailThreadMessage>(result.data);
    const first = messages[0];
    return {
      app: "gmail",
      outcome: messages.length ? "read_result" : "empty",
      summary:
        first && first.threadId
          ? `Loaded Gmail thread "${first.subject ?? "No subject"}" with ${messages.length} ${messages.length === 1 ? "message" : "messages"}.`
          : "That Gmail thread came back empty.",
      nextStep: first?.threadId
        ? "You can ask me to summarize it or trash it."
        : "You can ask me to search for another thread.",
      referenceEntities: first?.threadId
        ? [
            {
              kind: "gmail_thread",
              id: first.threadId,
              name: first.subject ?? "No subject"
            }
          ]
        : []
    };
  }

  if (toolName === "calendar_list_calendars") {
    const calendars = asArray<CalendarSummary>(result.data);
    return {
      app: "calendar",
      outcome: calendars.length ? "read_result" : "empty",
      summary: calendars.length
        ? `Found ${calendars.length} readable ${calendars.length === 1 ? "calendar" : "calendars"}.`
        : "No readable calendars showed up.",
      nextStep: calendars.length
        ? "You can ask me to show events from one of these calendars."
        : "You can try reconnecting Google Calendar or ask about another date range.",
      referenceEntities: calendars.slice(0, 10).map((calendar) => ({
        kind: "calendar",
        id: calendar.id,
        name: calendar.summary
      }))
    };
  }

  if (toolName === "calendar_list_events") {
    const events = asArray<CalendarEventSummary>(result.data);
    return {
      app: "calendar",
      outcome: events.length ? "read_result" : "empty",
      summary: events.length
        ? `Found ${events.length} calendar ${events.length === 1 ? "event" : "events"} in that window.`
        : "No calendar events matched that time window.",
      nextStep: events.length
        ? "You can ask me to move, cancel, or focus on one event."
        : "You can ask for another day or a wider time range.",
      referenceEntities: events
        .filter((event) => event.id)
        .slice(0, 10)
        .map((event) => ({
          kind: "calendar_event",
          id: event.id!,
          name: event.title,
          secondaryId: event.calendarId
        }))
    };
  }

  if (toolName === "drive_search_files") {
    const files = asArray<DriveFileSummary>(result.data);
    return {
      app: "drive",
      outcome: files.length ? "read_result" : "empty",
      summary: files.length
        ? `Found ${files.length} Drive ${files.length === 1 ? "file" : "files"}.`
        : "No Drive files matched that search.",
      nextStep: files.length
        ? "You can ask me to open, summarize, or delete one."
        : "You can try a different file name or search phrase.",
      referenceEntities: files.slice(0, 10).map((file) => ({
        kind: "drive_file",
        id: file.id,
        name: file.name
      }))
    };
  }

  if (toolName === "drive_read_file_metadata") {
    const file = result.data as DriveFileSummary | undefined;
    return {
      app: "drive",
      outcome: file?.id ? "read_result" : "empty",
      summary: file?.id ? `Loaded Drive file: ${file.name}.` : "That Drive file could not be loaded.",
      nextStep: file?.id
        ? "You can ask me to summarize it, open the Google Doc, or delete it."
        : "You can ask me to search for another file.",
      referenceEntities: file?.id
        ? [
            {
              kind: "drive_file",
              id: file.id,
              name: file.name
            }
          ]
        : []
    };
  }

  if (toolName === "docs_read_document") {
    const doc = result.data as ReadDocResult | undefined;
    return {
      app: "docs",
      outcome: doc?.documentId ? "read_result" : "empty",
      summary: doc?.documentId ? doc.summary : "That Google Doc could not be loaded.",
      nextStep: doc?.documentId
        ? "You can ask me to summarize it or append to it."
        : "You can ask me to search for another document.",
      referenceEntities: doc?.documentId
        ? [
            {
              kind: "google_doc",
              id: doc.documentId,
              name: doc.title
            }
          ]
        : []
    };
  }

  if (toolName === "web_search") {
    const webResult = result.data as WebSearchResult | undefined;
    return {
      app: "web",
      outcome: webResult?.summary ? "read_result" : "empty",
      summary:
        webResult?.summary ??
        (webResult?.query ? `I searched the web for ${webResult.query}.` : "The web search returned no summary."),
      nextStep:
        webResult?.sources?.length
          ? "You can ask me to dig into one source or verify a specific detail."
          : "You can ask a narrower question or give me a source to focus on.",
      referenceEntities: (webResult?.sources ?? []).slice(0, 5).map((source) => ({
        kind: "web_source",
        id: source.url,
        name: source.title ?? source.url
      }))
    };
  }

  if (toolName === "asana_list_workspaces") {
    const workspaces = asArray<AsanaWorkspaceSummary>(result.data);
    return {
      app: "asana",
      outcome: workspaces.length ? "read_result" : "empty",
      summary: workspaces.length
        ? `Found ${workspaces.length} Asana ${workspaces.length === 1 ? "workspace" : "workspaces"}.`
        : "No Asana workspaces showed up.",
      nextStep: workspaces.length
        ? "You can ask me to list projects in one of these workspaces."
        : "You can reconnect Asana or check whether the connected account has workspace access.",
      referenceEntities: workspaces.slice(0, 10).map((workspace) => ({
        kind: "asana_workspace",
        id: workspace.gid,
        name: workspace.name
      }))
    };
  }

  if (toolName === "asana_list_projects") {
    const projects = asArray<AsanaProjectSummary>(result.data);
    return {
      app: "asana",
      outcome: projects.length ? "read_result" : "empty",
      summary: projects.length
        ? `Found ${projects.length} Asana ${projects.length === 1 ? "project" : "projects"}.`
        : "No Asana projects matched in that workspace.",
      nextStep: projects.length
        ? "You can ask me to show tasks in one of these projects."
        : "You can try another workspace or a more specific project name.",
      referenceEntities: projects.slice(0, 10).map((project) => ({
        kind: "asana_project",
        id: project.gid,
        name: project.name
      }))
    };
  }

  if (toolName === "asana_list_teams") {
    const teams = asArray<AsanaTeamSummary>(result.data);
    return {
      app: "asana",
      outcome: teams.length ? "read_result" : "empty",
      summary: teams.length
        ? `Found ${teams.length} Asana ${teams.length === 1 ? "team" : "teams"}.`
        : "No Asana teams showed up in that workspace.",
      nextStep: teams.length
        ? "You can ask me to list projects or tasks for one of these teams."
        : "You can try another workspace or ask for project names instead.",
      referenceEntities: teams.slice(0, 10).map((team) => ({
        kind: "asana_team",
        id: team.gid,
        name: team.name
      }))
    };
  }

  if (toolName === "asana_list_users") {
    const users = asArray<AsanaUserSummary>(result.data);
    return {
      app: "asana",
      outcome: users.length ? "read_result" : "empty",
      summary: users.length
        ? `Found ${users.length} Asana ${users.length === 1 ? "user" : "users"}.`
        : "No Asana users matched in that workspace.",
      nextStep: users.length
        ? "You can ask me to assign or reassign a task to one of them."
        : "You can try another workspace or a more specific name.",
      referenceEntities: users.slice(0, 10).map((user) => ({
        kind: "asana_user",
        id: user.gid,
        name: user.name
      }))
    };
  }

  if (
    toolName === "asana_list_my_tasks" ||
    toolName === "asana_list_project_tasks" ||
    toolName === "asana_search_tasks"
  ) {
    const tasks = asArray<AsanaTaskSummary>(result.data);
    return {
      app: "asana",
      outcome: tasks.length ? "read_result" : "empty",
      summary: tasks.length
        ? `Found ${tasks.length} Asana ${tasks.length === 1 ? "task" : "tasks"}.`
        : "No Asana tasks matched that request.",
      nextStep: tasks.length
        ? "You can ask me to mark one done, reassign it, or rename it."
        : "You can ask for another project, date, or keyword.",
      referenceEntities: tasks.slice(0, 10).map((task) => ({
        kind: "asana_task",
        id: task.gid,
        name: task.name
      }))
    };
  }

  if (toolName === "asana_get_task") {
    const task = result.data as AsanaTaskDetail | undefined;
    return {
      app: "asana",
      outcome: task?.gid ? "read_result" : "empty",
      summary: task?.gid ? `Loaded Asana task: ${task.name}.` : "That Asana task could not be loaded.",
      nextStep: task?.gid
        ? "You can ask me to complete it, rename it, or change its due date."
        : "You can ask me to search for another task.",
      referenceEntities: task?.gid
        ? [
            {
              kind: "asana_task",
              id: task.gid,
              name: task.name
            }
          ]
        : []
    };
  }

  if (toolName === "asana_create_task" || toolName === "asana_update_task") {
    const task = result.data as AsanaTaskSummary | undefined;
    return {
      app: "asana",
      outcome: "write_complete",
      summary:
        toolName === "asana_create_task"
          ? `Created Asana task: ${task?.name ?? "task"}.`
          : `Updated Asana task: ${task?.name ?? "task"}.`,
      nextStep: task?.gid
        ? "You can ask me to reassign it, change its due date, or mark it done."
        : undefined,
      referenceEntities: task?.gid
        ? [
            {
              kind: "asana_task",
              id: task.gid,
              name: task.name
            }
          ]
        : []
    };
  }

  return {
    app: inferApp(toolName),
    outcome: "read_result",
    summary: `Completed ${toolName}.`,
    nextStep: undefined,
    referenceEntities: referenceEntitiesFromData(toolName, result.data)
  };
}

function inferApp(toolName: string): string {
  if (toolName.startsWith("asana_")) return "asana";
  if (toolName.startsWith("calendar_")) return "calendar";
  if (toolName.startsWith("gmail_")) return "gmail";
  if (toolName.startsWith("drive_")) return "drive";
  if (toolName.startsWith("docs_")) return "docs";
  if (toolName === "web_search") return "web";
  return "general";
}

function writeNextStep(toolName: string): string | undefined {
  if (toolName.startsWith("calendar_")) {
    return "You can ask me to move it, cancel it, or update the details.";
  }
  if (toolName.startsWith("docs_")) {
    return "You can ask me to append more or summarize it.";
  }
  if (toolName === "gmail_send_draft") {
    return "You can ask me to draft a follow-up or search related email.";
  }
  if (toolName === "gmail_trash_thread") {
    return "You can ask me to search the inbox again if you want to clean up more email.";
  }
  if (toolName === "drive_delete_file") {
    return "You can ask me to search Drive again if you want to clean up more files.";
  }
  if (toolName === "asana_delete_task") {
    return "You can ask me to list the remaining tasks or create a replacement.";
  }
  return undefined;
}

function referenceEntitiesFromData(toolName: string, data: unknown): ReferenceEntity[] {
  if (toolName.startsWith("calendar_")) {
    const events = normalizeToArray<CalendarEventSummary>(data);
    return events
      .filter((event) => event.id)
      .slice(0, 10)
      .map((event) => ({
        kind: "calendar_event",
        id: event.id!,
        name: event.title,
        secondaryId: event.calendarId
      }));
  }

  if (toolName.startsWith("drive_")) {
    const files = normalizeToArray<DriveFileSummary>(data);
    return files
      .filter((file) => file.id)
      .slice(0, 10)
      .map((file) => ({
        kind: "drive_file",
        id: file.id,
        name: file.name
      }));
  }

  return [];
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeToArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return value ? [value as T] : [];
}
