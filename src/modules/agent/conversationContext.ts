import type { PendingAction } from "@prisma/client";
import type { PendingToolPayload } from "./approvalPolicy";
import { detectReferencedApps, type ReferencedApp } from "./compoundIntent";

export interface PromptMemoryEntry {
  key: string;
  value: unknown;
  confidence?: number | null;
  updatedAt: Date;
}

export interface ConversationContext {
  activeApp: string;
  activeEntities: string[];
  recentResults: string[];
  pendingActionSummary: string;
  communicationHints: string[];
  userPreferences: string[];
}

export function buildConversationContext(input: {
  latestUserMessage: string;
  memoryEntries: PromptMemoryEntry[];
  pendingAction: PendingAction | null;
  pendingActionSummary: string;
}): ConversationContext {
  const messageApps = detectReferencedApps(input.latestUserMessage);
  const activeApp =
    messageApps.length > 1
      ? "multi"
      : (messageApps[0] ??
        inferActiveAppFromPendingAction(input.pendingAction) ??
        inferActiveAppFromMemory(input.memoryEntries) ??
        "general");
  const contextApps = activeApp === "multi" ? messageApps : undefined;

  const activeEntities: string[] = [];
  const recentResults: string[] = [];
  const communicationHints = new Set<string>();
  const userPreferences: string[] = [];

  for (const entry of input.memoryEntries) {
    if (entry.key === "preferred_timezone") {
      const timezone =
        entry.value &&
        typeof entry.value === "object" &&
        typeof (entry.value as { timezone?: unknown }).timezone === "string"
          ? (entry.value as { timezone: string }).timezone
          : null;
      if (timezone) userPreferences.push(`Preferred timezone: ${timezone}`);
      continue;
    }

    if (entry.key === "preferred_email_tone") {
      const tone =
        entry.value &&
        typeof entry.value === "object" &&
        typeof (entry.value as { tone?: unknown }).tone === "string"
          ? (entry.value as { tone: string }).tone
          : null;
      if (tone) userPreferences.push(`Preferred email tone: ${tone}`);
      continue;
    }

    if (isStaleContextEntry(entry)) continue;
    if (!memoryBelongsToActiveApp(entry.key, activeApp, contextApps)) continue;

    const { entities, resultSummary, hints } = summarizeEntry(entry);
    for (const entity of entities) {
      if (activeEntities.length < 8 && !activeEntities.includes(entity)) {
        activeEntities.push(entity);
      }
    }
    if (resultSummary && recentResults.length < 5) {
      recentResults.push(resultSummary);
    }
    for (const hint of hints) {
      communicationHints.add(hint);
    }
  }

  if (input.pendingAction) {
    communicationHints.add(
      "If the user refers to the pending action with phrases like send it, confirm it, change it, or cancel it, treat that as the active target."
    );
  }

  return {
    activeApp,
    activeEntities,
    recentResults,
    pendingActionSummary: input.pendingActionSummary,
    communicationHints: Array.from(communicationHints).slice(0, 6),
    userPreferences: userPreferences.slice(0, 4)
  };
}

export function formatConversationContextForPrompt(context: ConversationContext): string {
  return [
    `Active app/workflow: ${context.activeApp}`,
    "Active entities:",
    context.activeEntities.length ? context.activeEntities.map((line) => `- ${line}`).join("\n") : "- None",
    "Recent resolved context:",
    context.recentResults.length ? context.recentResults.map((line) => `- ${line}`).join("\n") : "- None",
    "Pending action summary:",
    context.pendingActionSummary,
    "Communication hints:",
    context.communicationHints.length
      ? context.communicationHints.map((line) => `- ${line}`).join("\n")
      : "- None",
    "User preferences:",
    context.userPreferences.length
      ? context.userPreferences.map((line) => `- ${line}`).join("\n")
      : "- None"
  ].join("\n");
}

function inferActiveAppFromPendingAction(pendingAction: PendingAction | null): string | null {
  if (!pendingAction) return null;
  const payload = pendingAction.payload as Partial<PendingToolPayload> | null;
  const toolName = payload?.toolName ?? "";
  if (toolName.startsWith("asana_")) return "asana";
  if (toolName.startsWith("calendar_")) return "calendar";
  if (toolName.startsWith("gmail_")) return "gmail";
  if (toolName.startsWith("docs_")) return "docs";
  if (toolName.startsWith("drive_")) return "drive";
  if (toolName === "web_search") return "web";
  return null;
}

function inferActiveAppFromMemory(entries: PromptMemoryEntry[]): string | null {
  for (const entry of entries) {
    if (entry.key.startsWith("recent_asana_")) return "asana";
    if (entry.key.startsWith("recent_calendar_")) return "calendar";
    if (entry.key === "recent_gmail_threads") return "gmail";
    if (entry.key === "recent_google_doc") return "docs";
    if (entry.key === "recent_drive_files") return "drive";
  }
  return null;
}

function memoryBelongsToActiveApp(
  key: string,
  activeApp: string,
  contextApps?: ReferencedApp[]
): boolean {
  if (activeApp === "multi") {
    return Boolean(contextApps?.some((app) => memoryBelongsToActiveApp(key, app)));
  }
  if (activeApp === "asana") return key.startsWith("recent_asana_");
  if (activeApp === "calendar") return key.startsWith("recent_calendar_");
  if (activeApp === "gmail") return key === "recent_gmail_threads";
  if (activeApp === "docs") return key === "recent_google_doc";
  if (activeApp === "drive") return key === "recent_drive_files" || key === "recent_google_doc";
  if (activeApp === "web") return false;
  return key.startsWith("recent_");
}

function isStaleContextEntry(entry: PromptMemoryEntry): boolean {
  if (!entry.key.startsWith("recent_")) return false;
  const ageMs = Date.now() - entry.updatedAt.getTime();
  return ageMs > 1000 * 60 * 60 * 24 * 30;
}

function summarizeEntry(entry: PromptMemoryEntry): {
  entities: string[];
  resultSummary?: string;
  hints: string[];
} {
  if (entry.key === "recent_google_doc") {
    const value = entry.value as {
      title?: string;
      documentId?: string;
      url?: string;
    };
    if (!value?.documentId) return { entities: [], hints: [] };
    return {
      entities: [
        `Google Doc: ${value.title ?? "Untitled"} (documentId: ${value.documentId})`
      ],
      resultSummary: `Current Google Doc: ${value.title ?? "Untitled"}.`,
      hints: [
        "If the user says same doc, current doc, that doc, or append to it, use the stored Google Doc above."
      ]
    };
  }

  if (entry.key === "recent_gmail_threads") {
    const threads = Array.isArray(entry.value) ? entry.value : [];
    const entities = threads
      .slice(0, 5)
      .map((thread) =>
        typeof thread === "object" && thread && typeof (thread as { threadId?: unknown }).threadId === "string"
          ? `Gmail thread: ${(thread as { subject?: string }).subject ?? "No subject"} (threadId: ${
              (thread as { threadId: string }).threadId
            })`
          : null
      )
      .filter((value): value is string => Boolean(value));
    return {
      entities,
      resultSummary: entities.length ? `Recent Gmail threads: ${entities.length} available.` : undefined,
      hints: entities.length
        ? [
            "If the user refers to those emails, that email, or the first listed thread, use the stored Gmail thread IDs."
          ]
        : []
    };
  }

  if (entry.key === "recent_calendar_events") {
    const events = Array.isArray(entry.value) ? entry.value : [];
    const entities = events
      .slice(0, 5)
      .map((event) =>
        typeof event === "object" && event && typeof (event as { eventId?: unknown }).eventId === "string"
          ? `Calendar event: ${(event as { title?: string }).title ?? "Untitled"} (eventId: ${
              (event as { eventId: string }).eventId
            }${typeof (event as { calendarId?: unknown }).calendarId === "string" ? `, calendarId: ${(event as { calendarId: string }).calendarId}` : ""})`
          : null
      )
      .filter((value): value is string => Boolean(value));
    return {
      entities,
      resultSummary: entities.length ? `Recent calendar events: ${entities.length} available.` : undefined,
      hints: entities.length
        ? [
            "If the user says move it, cancel it, reschedule it, or the first event, use the stored calendar event IDs."
          ]
        : []
    };
  }

  if (entry.key === "recent_calendars") {
    const calendars = Array.isArray(entry.value) ? entry.value : [];
    const entities = calendars
      .slice(0, 5)
      .map((calendar) =>
        typeof calendar === "object" && calendar && typeof (calendar as { calendarId?: unknown }).calendarId === "string"
          ? `Calendar: ${(calendar as { summary?: string }).summary ?? "Untitled"} (calendarId: ${
              (calendar as { calendarId: string }).calendarId
            })`
          : null
      )
      .filter((value): value is string => Boolean(value));
    return {
      entities,
      resultSummary: entities.length ? `Recent calendars: ${entities.length} available.` : undefined,
      hints: entities.length
        ? [
            "If the user refers to the same calendar or one of the listed calendars, use the stored calendar IDs."
          ]
        : []
    };
  }

  if (entry.key === "recent_drive_files") {
    const files = Array.isArray(entry.value) ? entry.value : [];
    const entities = files
      .slice(0, 5)
      .map((file) =>
        typeof file === "object" && file && typeof (file as { fileId?: unknown }).fileId === "string"
          ? `Drive file: ${(file as { name?: string }).name ?? "Untitled"} (fileId: ${
              (file as { fileId: string }).fileId
            })`
          : null
      )
      .filter((value): value is string => Boolean(value));
    return {
      entities,
      resultSummary: entities.length ? `Recent Drive files: ${entities.length} available.` : undefined,
      hints: entities.length
        ? [
            "If the user says same file, that file, or delete the first one, use the stored Drive file IDs."
          ]
        : []
    };
  }

  if (entry.key === "recent_asana_workspace") {
    const value = entry.value as { workspaceGid?: string; name?: string };
    if (!value?.workspaceGid) return { entities: [], hints: [] };
    return {
      entities: [
        `Asana workspace: ${value.name ?? "Unnamed"} (workspaceGid: ${value.workspaceGid})`
      ],
      resultSummary: `Active Asana workspace: ${value.name ?? "Unnamed"}.`,
      hints: ["Use the stored Asana workspace for follow-up task requests unless the user picks another one."]
    };
  }

  if (entry.key === "recent_asana_projects") {
    const projects = Array.isArray(entry.value) ? entry.value : [];
    const entities = projects
      .slice(0, 5)
      .map((project) =>
        typeof project === "object" && project && typeof (project as { projectGid?: unknown }).projectGid === "string"
          ? `Asana project: ${(project as { name?: string }).name ?? "Untitled"} (projectGid: ${
              (project as { projectGid: string }).projectGid
            })`
          : null
      )
      .filter((value): value is string => Boolean(value));
    return {
      entities,
      resultSummary: entities.length ? `Recent Asana projects: ${entities.length} available.` : undefined,
      hints: entities.length
        ? [
            "If the user refers to that project, the same project, or one of the listed projects, use the stored Asana project IDs."
          ]
        : []
    };
  }

  if (entry.key === "recent_asana_teams") {
    const teams = Array.isArray(entry.value) ? entry.value : [];
    const entities = teams
      .slice(0, 5)
      .map((team) =>
        typeof team === "object" && team && typeof (team as { teamGid?: unknown }).teamGid === "string"
          ? `Asana team: ${(team as { name?: string }).name ?? "Untitled"} (teamGid: ${
              (team as { teamGid: string }).teamGid
            })`
          : null
      )
      .filter((value): value is string => Boolean(value));
    return {
      entities,
      resultSummary: entities.length ? `Recent Asana teams: ${entities.length} available.` : undefined,
      hints: entities.length
        ? [
            "If the user refers to that team or one of the listed teams, use the stored Asana team IDs."
          ]
        : []
    };
  }

  if (entry.key === "recent_asana_tasks") {
    const tasks = Array.isArray(entry.value) ? entry.value : [];
    const entities = tasks
      .slice(0, 5)
      .map((task) =>
        typeof task === "object" && task && typeof (task as { taskGid?: unknown }).taskGid === "string"
          ? `Asana task: ${(task as { name?: string }).name ?? "Untitled"} (taskGid: ${
              (task as { taskGid: string }).taskGid
            })`
          : null
      )
      .filter((value): value is string => Boolean(value));
    return {
      entities,
      resultSummary: entities.length ? `Recent Asana tasks: ${entities.length} available.` : undefined,
      hints: entities.length
        ? [
            "If the user says that task, the first one, complete it, rename it, or reassign it, use the stored Asana task IDs."
          ]
        : []
    };
  }

  return { entities: [], hints: [] };
}
