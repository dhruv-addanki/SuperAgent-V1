import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ResponseToolDefinition } from "../lib/openaiClient";

const toJsonSchema = zodToJsonSchema as unknown as (
  schema: unknown,
  options: Record<string, unknown>
) => Record<string, unknown>;

const isoDate = z.string().datetime({ offset: true });
const isoDateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDateOrDateTime = z.union([isoDate, isoDateOnly]);

export const toolInputSchemas = {
  gmail_search_threads: z
    .object({
      query: z.string().min(1),
      maxResults: z.number().int().positive().max(20).optional()
    })
    .strict(),

  gmail_read_thread: z
    .object({
      threadId: z.string().min(1)
    })
    .strict(),

  gmail_create_draft: z
    .object({
      to: z.string().email(),
      subject: z.string().min(1),
      body: z.string().min(1)
    })
    .strict(),

  gmail_send_draft: z
    .object({
      draftId: z.string().min(1)
    })
    .strict(),

  gmail_trash_thread: z
    .object({
      threadId: z.string().min(1)
    })
    .strict(),

  calendar_list_calendars: z.object({}).strict(),

  calendar_list_events: z
    .object({
      timeMin: isoDate,
      timeMax: isoDate,
      calendarId: z.string().min(1).optional(),
      query: z.string().min(1).optional(),
      maxResults: z.number().int().positive().max(50).optional()
    })
    .strict(),

  calendar_create_event: z
    .object({
      calendarId: z.string().min(1).optional(),
      title: z.string().min(1),
      start: isoDate,
      end: isoDate,
      attendees: z.array(z.string().email()).optional(),
      location: z.string().optional(),
      description: z.string().optional()
    })
    .strict(),

  calendar_update_event: z
    .object({
      eventId: z.string().min(1),
      calendarId: z.string().min(1).optional(),
      targetCalendarId: z.string().min(1).optional(),
      title: z.string().min(1).optional(),
      start: isoDate.optional(),
      end: isoDate.optional(),
      attendees: z.array(z.string().email()).optional(),
      location: z.string().optional(),
      description: z.string().optional()
    })
    .strict(),

  calendar_delete_event: z
    .object({
      eventId: z.string().min(1),
      calendarId: z.string().min(1).optional()
    })
    .strict(),

  drive_search_files: z
    .object({
      query: z.string().min(1),
      mimeType: z.string().optional(),
      modifiedAfter: isoDate.optional()
    })
    .strict(),

  drive_read_file_metadata: z
    .object({
      fileId: z.string().min(1)
    })
    .strict(),

  drive_delete_file: z
    .object({
      fileId: z.string().min(1)
    })
    .strict(),

  web_search: z
    .object({
      query: z.string().min(1),
      allowedDomains: z.array(z.string().min(1)).max(20).optional()
    })
    .strict(),

  docs_read_document: z
    .object({
      documentId: z.string().min(1)
    })
    .strict(),

  docs_append_document: z
    .object({
      documentId: z.string().min(1),
      content: z.string().min(1)
    })
    .strict(),

  docs_create_document: z
    .object({
      title: z.string().min(1),
      content: z.string().min(1),
      folderId: z.string().optional()
    })
    .strict(),

  asana_list_workspaces: z.object({}).strict(),

  asana_list_projects: z
    .object({
      workspaceGid: z.string().min(1),
      query: z.string().min(1).optional()
    })
    .strict(),

  asana_list_teams: z
    .object({
      workspaceGid: z.string().min(1),
      query: z.string().min(1).optional()
    })
    .strict(),

  asana_list_users: z
    .object({
      workspaceGid: z.string().min(1),
      query: z.string().min(1).optional()
    })
    .strict(),

  asana_list_my_tasks: z
    .object({
      workspaceGid: z.string().min(1).optional(),
      projectGid: z.string().min(1).optional(),
      completed: z.boolean().optional(),
      dueOn: isoDateOnly.optional(),
      dueBefore: isoDateOrDateTime.optional(),
      limit: z.number().int().positive().max(100).optional()
    })
    .strict(),

  asana_list_project_tasks: z
    .object({
      projectGid: z.string().min(1),
      completed: z.boolean().optional(),
      dueOn: isoDateOnly.optional(),
      dueBefore: isoDateOrDateTime.optional(),
      limit: z.number().int().positive().max(100).optional()
    })
    .strict(),

  asana_search_tasks: z
    .object({
      workspaceGid: z.string().min(1).optional(),
      text: z.string().min(1),
      projectGid: z.string().min(1).optional(),
      assigneeGid: z.string().min(1).optional(),
      completed: z.boolean().optional(),
      limit: z.number().int().positive().max(100).optional()
    })
    .strict(),

  asana_get_task: z
    .object({
      taskGid: z.string().min(1)
    })
    .strict(),

  asana_create_task: z
    .object({
      workspaceGid: z.string().min(1).optional(),
      name: z.string().min(1),
      notes: z.string().min(1).optional(),
      dueOn: isoDateOnly.optional(),
      dueAt: isoDate.optional(),
      assigneeGid: z.string().min(1).optional(),
      projectGids: z.array(z.string().min(1)).max(20).optional()
    })
    .strict(),

  asana_update_task: z
    .object({
      taskGid: z.string().min(1),
      name: z.string().min(1).optional(),
      notes: z.string().min(1).optional(),
      dueOn: isoDateOnly.nullable().optional(),
      dueAt: isoDate.nullable().optional(),
      assigneeGid: z.string().min(1).nullable().optional(),
      completed: z.boolean().optional()
    })
    .strict(),

  asana_delete_task: z
    .object({
      taskGid: z.string().min(1)
    })
    .strict()
} as const;

export type ToolName = keyof typeof toolInputSchemas;
export type ToolInput<TName extends ToolName = ToolName> = z.infer<
  (typeof toolInputSchemas)[TName]
>;

export const toolDescriptions: Record<ToolName, string> = {
  gmail_search_threads: "Search Gmail threads and return concise normalized summaries.",
  gmail_read_thread: "Read a Gmail thread by ID and return normalized messages.",
  gmail_create_draft: "Create a Gmail draft. This does not send the email.",
  gmail_send_draft:
    "Send an existing Gmail draft by draft ID. Use this after gmail_create_draft when the user clearly asked to send.",
  gmail_trash_thread:
    "Move a Gmail thread to Trash by thread ID. Use this when the user clearly asks to delete email(s).",
  calendar_list_calendars: "List the user's Google calendars and their IDs.",
  calendar_list_events:
    "List Google Calendar events in a time window. If calendarId is omitted, return events across all readable calendars.",
  calendar_create_event:
    "Create a Google Calendar event on a specified calendar or the primary calendar.",
  calendar_update_event:
    "Update an existing Google Calendar event, optionally moving it to another calendar.",
  calendar_delete_event: "Delete a Google Calendar event from a specified calendar.",
  drive_search_files: "Search Google Drive files by text query and optional filters.",
  drive_read_file_metadata: "Read metadata for a Google Drive file.",
  drive_delete_file:
    "Move a Google Drive file, including a Google Doc, to trash by file ID.",
  web_search:
    "Search the public web for current factual information and return a concise summary with source URLs.",
  docs_read_document: "Read the contents of a Google Doc by document ID.",
  docs_append_document:
    "Append content to an existing Google Doc by document ID. Use this when the user refers to an existing/current/same doc.",
  docs_create_document:
    "Create a new Google Doc with the supplied title and content. Use only when the user explicitly wants a new document.",
  asana_list_workspaces: "List the Asana workspaces visible to the connected user.",
  asana_list_projects:
    "List Asana projects in a workspace, including team projects when available. Use this to resolve a project before reading or writing tasks.",
  asana_list_teams:
    "List Asana teams in a workspace. Use this when the user refers to a team or when project discovery needs more workspace context.",
  asana_list_users:
    "List Asana users in a workspace. Use this to resolve an assignee before creating or reassigning tasks.",
  asana_list_my_tasks:
    "List tasks from Asana My Tasks. Prefer this for personal task browsing, due today, due soon, or follow-up requests about the user's own work.",
  asana_list_project_tasks:
    "List tasks from a specific Asana project. Prefer this for project browsing instead of Asana search.",
  asana_search_tasks:
    "Search Asana tasks in a workspace by literal text and optional filters. Use this only for explicit keyword search requests.",
  asana_get_task: "Read a single Asana task by task GID.",
  asana_create_task: "Create a new Asana task.",
  asana_update_task:
    "Update an existing Asana task. Use this to rename, reassign, change dates, or mark a task complete or incomplete.",
  asana_delete_task:
    "Delete an existing Asana task by task GID. Use this only when the user clearly asks to delete or remove the task."
};

export const readOnlyToolNames = [
  "gmail_search_threads",
  "gmail_read_thread",
  "web_search",
  "calendar_list_calendars",
  "calendar_list_events",
  "drive_search_files",
  "drive_read_file_metadata",
  "docs_read_document",
  "asana_list_workspaces",
  "asana_list_projects",
  "asana_list_teams",
  "asana_list_users",
  "asana_list_my_tasks",
  "asana_list_project_tasks",
  "asana_search_tasks",
  "asana_get_task"
] as const satisfies readonly ToolName[];

export const writeToolNames = [
  "gmail_create_draft",
  "gmail_send_draft",
  "gmail_trash_thread",
  "calendar_create_event",
  "calendar_update_event",
  "calendar_delete_event",
  "drive_delete_file",
  "docs_append_document",
  "docs_create_document",
  "asana_create_task",
  "asana_update_task",
  "asana_delete_task"
] as const satisfies readonly ToolName[];

export function isToolName(value: string): value is ToolName {
  return value in toolInputSchemas;
}

export function isReadOnlyTool(toolName: ToolName): boolean {
  return (readOnlyToolNames as readonly string[]).includes(toolName);
}

export function isWriteTool(toolName: ToolName): boolean {
  return (writeToolNames as readonly string[]).includes(toolName);
}

export function buildToolDefinitions(readOnlyMode: boolean): ResponseToolDefinition[] {
  return (Object.keys(toolInputSchemas) as ToolName[])
    .filter((toolName) => !readOnlyMode || isReadOnlyTool(toolName))
    .map((toolName) => {
      const schema = toolInputSchemas[toolName] as z.ZodTypeAny;
      const jsonSchema = toJsonSchema(schema, {
        name: toolName,
        $refStrategy: "none"
      });
      const parameters =
        ((jsonSchema.definitions as Record<string, Record<string, unknown>> | undefined)?.[
          toolName
        ] as Record<string, unknown> | undefined) ?? jsonSchema;

      return {
        type: "function",
        name: toolName,
        description: toolDescriptions[toolName],
        parameters
      };
    });
}
