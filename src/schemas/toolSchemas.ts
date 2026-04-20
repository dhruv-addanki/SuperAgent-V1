import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ResponseToolDefinition } from "../lib/openaiClient";

const toJsonSchema = zodToJsonSchema as unknown as (
  schema: unknown,
  options: Record<string, unknown>
) => Record<string, unknown>;

const isoDate = z.string().datetime({ offset: true });

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

  calendar_list_events: z
    .object({
      timeMin: isoDate,
      timeMax: isoDate
    })
    .strict(),

  calendar_create_event: z
    .object({
      title: z.string().min(1),
      start: isoDate,
      end: isoDate,
      attendees: z.array(z.string().email()).optional(),
      location: z.string().optional(),
      description: z.string().optional()
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

  docs_create_document: z
    .object({
      title: z.string().min(1),
      content: z.string().min(1),
      folderId: z.string().optional()
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
  gmail_send_draft: "Send an existing Gmail draft by draft ID. Requires approval.",
  calendar_list_events: "List Google Calendar events in a time window.",
  calendar_create_event: "Create a Google Calendar event on the primary calendar.",
  drive_search_files: "Search Google Drive files by text query and optional filters.",
  drive_read_file_metadata: "Read metadata for a Google Drive file.",
  docs_create_document: "Create a Google Doc with the supplied title and content."
};

export const readOnlyToolNames = [
  "gmail_search_threads",
  "gmail_read_thread",
  "calendar_list_events",
  "drive_search_files",
  "drive_read_file_metadata"
] as const satisfies readonly ToolName[];

export const writeToolNames = [
  "gmail_create_draft",
  "gmail_send_draft",
  "calendar_create_event",
  "docs_create_document"
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
      return {
        type: "function",
        name: toolName,
        description: toolDescriptions[toolName],
        parameters: toJsonSchema(schema, {
          name: toolName,
          $refStrategy: "none"
        }),
        strict: true
      };
    });
}
