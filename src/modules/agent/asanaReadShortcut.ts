import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import type { AsanaTaskSummary } from "../asana/asanaTypes";

export type GenericAsanaTaskTarget = "today" | "tomorrow";

export function matchGenericAsanaMyTasksRequest(
  text: string
): GenericAsanaTaskTarget | null {
  const normalized = text.trim().toLowerCase();
  const referencesAsana = /\basana\b/.test(normalized);
  const referencesPersonalTasks =
    /\bmy asana tasks\b/.test(normalized) ||
    /\bmy tasks\b/.test(normalized) ||
    (/\basana tasks\b/.test(normalized) && /\bmy\b/.test(normalized));
  const asksForTasks =
    /\bshow\b/.test(normalized) ||
    /\blist\b/.test(normalized) ||
    /\bcheck\b/.test(normalized) ||
    /\bwhat(?:'s|s)? due\b/.test(normalized);
  const referencesProjectContext = /\bproject\b/.test(normalized) || /\bteam\b/.test(normalized);

  if (!referencesAsana || !referencesPersonalTasks || !asksForTasks || referencesProjectContext) {
    return null;
  }

  if (/\btomorrow\b/.test(normalized)) return "tomorrow";
  if (/\btoday\b/.test(normalized)) return "today";
  return null;
}

export function asanaTaskDueDate(
  target: GenericAsanaTaskTarget,
  timezone: string,
  baseDate = new Date()
): string {
  const zoned = toZonedTime(baseDate, timezone);
  const day = new Date(zoned);
  if (target === "tomorrow") {
    day.setDate(day.getDate() + 1);
  }

  return formatInTimeZone(day, timezone, "yyyy-MM-dd");
}

export function formatAsanaTaskOverview(
  tasks: AsanaTaskSummary[],
  label: GenericAsanaTaskTarget
): string {
  if (!tasks.length) {
    return `You have no Asana tasks due ${label}.`;
  }

  const body = tasks
    .slice(0, 20)
    .map((task, index) => `${index + 1}. ${task.name}`)
    .join("\n");

  return `Your Asana tasks due ${label}:\n\n${body}`;
}
