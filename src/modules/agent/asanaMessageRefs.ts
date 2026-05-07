import type { AsanaTaskSummary } from "../asana/asanaTypes";

export interface AsanaAssistantTaskRef {
  taskGid: string;
  name?: string;
  projectName?: string;
  dueOn?: string;
  completed?: boolean;
  index?: number;
  scopeLabel?: string;
}

export interface AssistantDeliveryMetadata {
  channel: "text" | "template";
  messageId?: string;
}

export function asanaTaskRefsFromSummaries(
  tasks: AsanaTaskSummary[],
  scopeLabel?: string
): AsanaAssistantTaskRef[] {
  return tasks
    .filter((task) => task.gid)
    .slice(0, 50)
    .map((task, index) => ({
      taskGid: task.gid,
      name: task.name,
      ...(task.projects?.[0]?.name ? { projectName: task.projects[0].name } : {}),
      ...(task.dueOn ? { dueOn: task.dueOn } : {}),
      completed: task.completed,
      index: index + 1,
      ...(scopeLabel ? { scopeLabel } : {})
    }));
}

export function buildAssistantMessageRawPayload(input: {
  source: string;
  delivery?: AssistantDeliveryMetadata;
  asanaTaskRefs?: AsanaAssistantTaskRef[];
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    source: input.source,
    ...(input.extra ?? {})
  };

  if (input.delivery) {
    payload.whatsapp = {
      channel: input.delivery.channel,
      ...(input.delivery.messageId ? { messageId: input.delivery.messageId } : {})
    };
  }

  if (input.asanaTaskRefs?.length) {
    payload.asanaTaskRefs = input.asanaTaskRefs.slice(0, 50);
  }

  return payload;
}

export function extractAsanaTaskRefsFromRawPayload(rawPayload: unknown): AsanaAssistantTaskRef[] {
  if (!rawPayload || typeof rawPayload !== "object") return [];
  const refs = (rawPayload as { asanaTaskRefs?: unknown }).asanaTaskRefs;
  if (!Array.isArray(refs)) return [];

  return refs
    .map((ref): AsanaAssistantTaskRef | null => {
      if (!ref || typeof ref !== "object") return null;
      const value = ref as {
        taskGid?: unknown;
        name?: unknown;
        projectName?: unknown;
        dueOn?: unknown;
        completed?: unknown;
        index?: unknown;
        scopeLabel?: unknown;
      };
      if (typeof value.taskGid !== "string" || !value.taskGid.trim()) return null;
      return {
        taskGid: value.taskGid,
        ...(typeof value.name === "string" ? { name: value.name } : {}),
        ...(typeof value.projectName === "string" ? { projectName: value.projectName } : {}),
        ...(typeof value.dueOn === "string" ? { dueOn: value.dueOn } : {}),
        ...(typeof value.completed === "boolean" ? { completed: value.completed } : {}),
        ...(typeof value.index === "number" ? { index: value.index } : {}),
        ...(typeof value.scopeLabel === "string" ? { scopeLabel: value.scopeLabel } : {})
      };
    })
    .filter((ref): ref is AsanaAssistantTaskRef => ref !== null);
}

export function whatsappMessageIdFromRawPayload(rawPayload: unknown): string | null {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const whatsapp = (rawPayload as { whatsapp?: unknown }).whatsapp;
  if (!whatsapp || typeof whatsapp !== "object") return null;
  const messageId = (whatsapp as { messageId?: unknown }).messageId;
  return typeof messageId === "string" && messageId.trim() ? messageId : null;
}
