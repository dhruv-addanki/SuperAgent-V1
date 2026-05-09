import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import type { ResponseInputItem } from "../../lib/openaiClient";
import { formatForUser } from "../../lib/time";
import type { AsanaTaskSummary } from "../asana/asanaTypes";
import type { PromptMemoryEntry } from "./conversationContext";

export type GenericAsanaTaskTarget = "today" | "tomorrow";

export interface ResolvedAsanaProjectShortcut {
  projectGid?: string;
  name: string;
}

export interface AsanaListShortcut {
  scope: "my_tasks" | "project";
  project?: ResolvedAsanaProjectShortcut;
  dueOn?: string;
  dueAfter?: string;
  dueBefore?: string;
  completed?: boolean;
  sortBy?: "due" | "createdAt" | "modifiedAt" | "completedAt";
  sortDirection?: "asc" | "desc";
  limit: number;
  requestedLimit?: number;
  label: string;
  emphasizeImportance?: boolean;
}

export interface AsanaLatestTaskShortcut {
  scope: "my_tasks" | "project";
  project?: ResolvedAsanaProjectShortcut;
  completed: boolean;
  sortBy: "modifiedAt" | "completedAt";
  sortDirection: "asc" | "desc";
  limit: 1;
  label: string;
}

export interface AsanaListThenCompleteShortcut {
  listShortcut: AsanaListShortcut;
  listText: string;
}

export interface AsanaMultiCreateShortcut {
  tasks: Array<{
    name: string;
    dueOn?: string;
  }>;
}

export type AsanaDueDateUpdateShortcut =
  | {
      status: "resolved";
      taskName: string;
      dueOn: string | null;
    }
  | {
      status: "needs_due_date" | "needs_task";
      taskName?: string;
      message: string;
    };

export interface AsanaBulkCompleteClarification {
  taskCount: number;
  projectName?: string;
}

export interface LastVisibleAsanaTaskList {
  scopeLabel?: string;
  createdAt?: string;
  updatedAt?: Date;
  returnedCount?: number;
  storedCount?: number;
  tasks: Array<{
    taskGid: string;
    name?: string;
    projectName?: string;
    dueOn?: string;
    completed?: boolean;
  }>;
}

export type AsanaCompletionTargetResolution =
  | { status: "resolved"; tasks: LastVisibleAsanaTaskList["tasks"] }
  | {
      status: "needs_list" | "stale" | "empty" | "too_many" | "ambiguous" | "broad";
      message: string;
    };

export interface AsanaCompletionReferenceOptions {
  referenceList?: LastVisibleAsanaTaskList | null;
  bypassFreshnessCheck?: boolean;
}

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11
};
const MONTH_NAME_PATTERN =
  "january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec";
const MONTH_DAY_REFERENCE_PATTERN = `(?:${MONTH_NAME_PATTERN})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,\\s*\\d{4})?`;
const ISO_DATE_REFERENCE_PATTERN = "\\d{4}-\\d{2}-\\d{2}";
const SLASH_DATE_REFERENCE_PATTERN = "\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?";
const DATE_ONLY_FOLLOW_UP_PATTERN = new RegExp(
  `^(?:(?:what|how)\\s+about\\s+|and\\s+|for\\s+|from\\s+|on\\s+|due\\s+|back\\s+to\\s+)?(?:overdue|old|before\\s+today|before\\s+yesterday|today|tomorrow|yesterday|${MONTH_DAY_REFERENCE_PATTERN}|${ISO_DATE_REFERENCE_PATTERN}|${SLASH_DATE_REFERENCE_PATTERN}|before\\s+(?:${MONTH_DAY_REFERENCE_PATTERN}|${ISO_DATE_REFERENCE_PATTERN}|${SLASH_DATE_REFERENCE_PATTERN}))$`
);
const LAST_VISIBLE_ASANA_TASK_LIST_FRESH_MS = 2 * 60 * 60 * 1000;

export function matchGenericAsanaMyTasksRequest(text: string): GenericAsanaTaskTarget | null {
  const normalized = normalize(text);
  if (isLikelyAsanaWriteRequest(normalized)) return null;
  const referencesAsana = /\basana\b/.test(normalized);
  const referencesPersonalTasks =
    /\bmy asana tasks\b/.test(normalized) ||
    /\bmy tasks\b/.test(normalized) ||
    (/\basana tasks\b/.test(normalized) && /\bmy\b/.test(normalized));
  const asksForTasks =
    /\bshow\b/.test(normalized) ||
    /\blist\b/.test(normalized) ||
    /\bcheck\b/.test(normalized) ||
    /\bwhat(?:'s|s)? due\b/.test(normalized) ||
    /\bimportant\b/.test(normalized) ||
    /\bmain\b/.test(normalized);
  const referencesProjectContext = /\bproject\b/.test(normalized) || /\bteam\b/.test(normalized);

  if (!referencesAsana || !referencesPersonalTasks || !asksForTasks || referencesProjectContext) {
    return null;
  }

  if (/\btomorrow\b/.test(normalized)) return "tomorrow";
  if (/\btoday\b/.test(normalized)) return "today";
  return null;
}

export function matchGenericAsanaOpenTasksRequest(text: string): boolean {
  const normalized = normalize(text);
  if (isLikelyAsanaWriteRequest(normalized)) return false;
  if (matchAsanaProjectsRequest(text)) return false;

  const referencesAsana = /\basana\b/.test(normalized);
  const referencesTasks =
    /\bmy tasks\b/.test(normalized) ||
    /\basana tasks\b/.test(normalized) ||
    /\ball asana tasks\b/.test(normalized);
  const asksForOverview =
    /\bcheck\b/.test(normalized) ||
    /\bshow\b/.test(normalized) ||
    /\blist\b/.test(normalized) ||
    /\bwhat(?:'s|s)?\b/.test(normalized);

  if (!asksForOverview) return false;
  if (/\btoday\b|\btomorrow\b|\bdue\b|\bbefore\b/.test(normalized)) return false;
  return referencesAsana || referencesTasks;
}

export function matchAsanaProjectsRequest(text: string): boolean {
  const normalized = normalize(text);
  const asksForOverview =
    /\bwhat(?:'s|s)?\b/.test(normalized) ||
    /\bwhich\b/.test(normalized) ||
    /\bshow\b/.test(normalized) ||
    /\blist\b/.test(normalized) ||
    /\bcheck\b/.test(normalized);
  if (/\btasks?\b/.test(normalized)) return false;
  return asksForOverview && /\basana\b/.test(normalized) && /\bprojects?\b/.test(normalized);
}

export function matchListedAsanaBulkCompleteRequest(text: string): boolean {
  const normalized = normalize(text);
  const asksToComplete =
    /\bcomplete\b/.test(normalized) ||
    /\bmark\b.*\b(?:complete|done|finished)\b/.test(normalized) ||
    /\bmark\b.*\bas complete\b/.test(normalized);
  const referencesListedTasks =
    /\bthose\b/.test(normalized) ||
    /\bthese\b/.test(normalized) ||
    /\bthem\b/.test(normalized) ||
    /\blisted\b/.test(normalized) ||
    /\bthe list\b/.test(normalized) ||
    /\bthat list\b/.test(normalized);
  return asksToComplete && referencesListedTasks && /\btasks?\b/.test(normalized);
}

export function matchAsanaBulkRetryRequest(
  text: string,
  memoryEntries: PromptMemoryEntry[]
): boolean {
  const normalized = normalize(text);
  if (!/\b(?:try again|retry|rerun|run it again)\b/.test(normalized)) return false;
  return Boolean(memoryEntries.find((entry) => entry.key === "last_failed_asana_bulk_update"));
}

export function matchAsanaMultiCreateRequest(
  text: string,
  timezone: string,
  baseDate = new Date()
): AsanaMultiCreateShortcut | null {
  const normalized = normalize(text);
  const asksCreateTasks =
    /\b(?:add|create|make|set up)\b[^.?!]*\btasks?\b/.test(normalized) ||
    /\btasks?\b[^.?!]*\b(?:add|create|make|set up)\b/.test(normalized);
  if (!asksCreateTasks) return null;

  const names = extractNamedTaskCreations(text);
  if (names.length < 2) return null;

  const dueOn = parseCreateDueOn(normalized, timezone, baseDate);
  return {
    tasks: names.slice(0, 10).map((name) => ({
      name,
      ...(dueOn ? { dueOn } : {})
    }))
  };
}

export function matchAsanaDueDateUpdateRequest(
  text: string,
  timezone: string,
  baseDate = new Date()
): AsanaDueDateUpdateShortcut | null {
  const normalized = normalizeIntentText(text);
  if (!/\b(?:move|change|update|set|make|reschedule)\b/.test(normalized)) return null;
  if (!/\b(?:asana|tasks?|due date)\b/.test(normalized)) return null;
  if (!/\b(?:due|date|today|tomorrow|tmr|tmrw|yesterday|from)\b/.test(normalized)) return null;

  const taskName = extractDueDateUpdateTaskName(text);
  const dueOn = parseDueDateUpdateTarget(normalized, timezone, baseDate);

  if (dueOn === undefined) {
    if (/\bfrom\s*$|\b(?:to|due|date)\s*$/.test(normalized)) {
      return {
        status: "needs_due_date",
        ...(taskName ? { taskName } : {}),
        message: taskName
          ? `What due date should I move "${taskName}" to?`
          : "What due date should I move that Asana task to?"
      };
    }
    return null;
  }

  if (!taskName) {
    return {
      status: "needs_task",
      message: "Which Asana task should I update?"
    };
  }

  return { status: "resolved", taskName, dueOn };
}

export function matchAsanaOverdueOfferConfirmation(
  text: string,
  history: ResponseInputItem[]
): boolean {
  const normalized = normalize(text)
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!/^(?:yes|yeah|yep|sure|ok|okay|please do|do that)$/i.test(normalized)) return false;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.role !== "assistant") continue;
    const content = typeof item.content === "string" ? normalize(item.content) : "";
    if (!content) continue;
    return /\bshow overdue tasks instead\b|\boverdue tasks instead\b/.test(content);
  }

  return false;
}

export function lastVisibleAsanaTaskList(
  memoryEntries: PromptMemoryEntry[]
): LastVisibleAsanaTaskList | null {
  const entry = memoryEntries.find((item) => item.key === "last_visible_asana_task_list");
  if (!entry || !entry.value || typeof entry.value !== "object") return null;
  const record = entry.value as {
    tasks?: unknown;
    scopeLabel?: unknown;
    createdAt?: unknown;
    returnedCount?: unknown;
    storedCount?: unknown;
  };
  if (!Array.isArray(record.tasks)) return null;

  const tasks: LastVisibleAsanaTaskList["tasks"] = [];
  for (const task of record.tasks) {
    if (!task || typeof task !== "object") continue;
    const value = task as {
      taskGid?: unknown;
      name?: unknown;
      projectName?: unknown;
      dueOn?: unknown;
      completed?: unknown;
    };
    if (typeof value.taskGid !== "string") continue;
    tasks.push({
      taskGid: value.taskGid,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.projectName === "string" ? { projectName: value.projectName } : {}),
      ...(typeof value.dueOn === "string" ? { dueOn: value.dueOn } : {}),
      ...(typeof value.completed === "boolean" ? { completed: value.completed } : {})
    });
  }

  return {
    scopeLabel: typeof record.scopeLabel === "string" ? record.scopeLabel : undefined,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
    updatedAt: entry.updatedAt,
    returnedCount: typeof record.returnedCount === "number" ? record.returnedCount : tasks.length,
    storedCount: typeof record.storedCount === "number" ? record.storedCount : tasks.length,
    tasks
  };
}

export function resolveConcreteAsanaCompletionTarget(
  text: string,
  memoryEntries: PromptMemoryEntry[],
  now = new Date(),
  options: AsanaCompletionReferenceOptions = {}
): AsanaCompletionTargetResolution | null {
  const normalized = normalizeCompletionText(text);
  if (!asksToCompleteAsanaTask(normalized)) return null;

  const recentList = options.referenceList ?? lastVisibleAsanaTaskList(memoryEntries);
  if (options.referenceList && referencesClusterCompletionTarget(normalized)) {
    const tasks = options.referenceList.tasks.filter((task) => task.taskGid);
    if (!tasks.length) {
      return {
        status: "empty",
        message: "The referenced Asana cluster has no tasks to complete."
      };
    }
    if (tasks.length > 25) {
      return {
        status: "too_many",
        message:
          "That Asana cluster is too large for an automatic bulk completion. Narrow it to 25 tasks or fewer."
      };
    }
    return { status: "resolved", tasks };
  }

  if (isBroadAsanaCompletionRequest(normalized)) {
    if (!recentList && hasLegacyRecentAsanaTasks(memoryEntries)) return null;
    return {
      status: "broad",
      message: "Do you mean the listed Asana tasks, or every incomplete Asana task I can see?"
    };
  }

  if (!recentList) {
    return {
      status: "needs_list",
      message:
        "I don't have a recent Asana task list to apply that to. Ask me to show the tasks first."
    };
  }

  if (!options.bypassFreshnessCheck && !isFreshAsanaTaskList(recentList, now)) {
    return {
      status: "stale",
      message:
        "That Asana task list is stale. Ask me to show the tasks again before completing them."
    };
  }

  const tasks = recentList.tasks.filter((task) => task.taskGid);
  if (!tasks.length) {
    return {
      status: "empty",
      message: "The last Asana task list I showed had no tasks to complete."
    };
  }

  const explicitPastedTargets = resolveExplicitPastedCompletionTargets(text, tasks);
  if (explicitPastedTargets === "too_many") {
    return {
      status: "too_many",
      message:
        "That pasted Asana task list is too large for an automatic bulk completion. Narrow it to 25 tasks or fewer."
    };
  }
  if (explicitPastedTargets && "unresolved" in explicitPastedTargets) {
    return {
      status: "ambiguous",
      message: [
        "I could not resolve every pasted Asana task, so I did not complete a partial list.",
        `Unresolved: ${explicitPastedTargets.unresolved.join("; ")}`,
        "Ask me to show the tasks again or reply to the exact task list."
      ].join("\n")
    };
  }
  if (explicitPastedTargets?.length) {
    return { status: "resolved", tasks: explicitPastedTargets };
  }

  const firstShownTargets = resolveFirstShownCompletionTargets(normalized, tasks);
  if (firstShownTargets === "too_many") {
    return {
      status: "too_many",
      message:
        "I can complete at most 25 listed Asana tasks at once. Narrow the list or choose task numbers."
    };
  }
  if (firstShownTargets === "out_of_range") {
    return {
      status: "ambiguous",
      message: `The last Asana list only has ${tasks.length} stored tasks. Pick a number from 1 to ${tasks.length}.`
    };
  }
  if (firstShownTargets.length) {
    return { status: "resolved", tasks: firstShownTargets };
  }

  const ordinalTargets = resolveOrdinalCompletionTargets(normalized, tasks);
  if (ordinalTargets === "out_of_range") {
    return {
      status: "ambiguous",
      message: `That task number is outside the last Asana list I showed. Pick a number from 1 to ${tasks.length}.`
    };
  }
  if (ordinalTargets.length) {
    return { status: "resolved", tasks: ordinalTargets };
  }

  const namedTargets = resolveNamedCompletionTargets(normalized, tasks);
  if (namedTargets === "ambiguous") {
    return {
      status: "ambiguous",
      message: "I found multiple listed Asana tasks with that name. Say the task number instead."
    };
  }
  if (namedTargets.length) {
    return { status: "resolved", tasks: namedTargets };
  }

  if (referencesAllListedTasks(normalized)) {
    const returnedCount = recentList.returnedCount ?? tasks.length;
    if (returnedCount > tasks.length || returnedCount > 25) {
      return {
        status: "too_many",
        message:
          "That Asana list is too large for an automatic bulk completion. Narrow the list or say complete the first 25 shown."
      };
    }
    return { status: "resolved", tasks };
  }

  if (referencesSingleRecentTask(normalized)) {
    if (tasks.length === 1) return { status: "resolved", tasks };
    return {
      status: "ambiguous",
      message: "Which listed Asana task should I complete? Reply with the task number."
    };
  }

  return null;
}

export function matchAsanaListThenCompleteRequest(
  text: string,
  history: ResponseInputItem[],
  memoryEntries: PromptMemoryEntry[],
  timezone: string,
  baseDate = new Date()
): AsanaListThenCompleteShortcut | null {
  const normalized = normalizeCompletionText(text);
  if (!asksToCompleteAsanaTask(normalized) || !referencesAllListedTasks(normalized)) return null;

  const listText = extractAsanaListClauseBeforeCompletion(text);
  if (!listText) return null;

  const listShortcut = matchAsanaListShortcut(listText, history, memoryEntries, timezone, baseDate);
  return listShortcut ? { listShortcut, listText } : null;
}

export function lastFailedAsanaBulkRetryTaskList(
  memoryEntries: PromptMemoryEntry[]
): LastVisibleAsanaTaskList | null {
  const entry = memoryEntries.find((item) => item.key === "last_failed_asana_bulk_update");
  if (!entry || !entry.value || typeof entry.value !== "object") return null;
  const record = entry.value as { retryableTasks?: unknown; summary?: unknown };
  if (!Array.isArray(record.retryableTasks)) {
    return {
      scopeLabel: typeof record.summary === "string" ? record.summary : undefined,
      tasks: []
    };
  }

  const tasks: LastVisibleAsanaTaskList["tasks"] = [];
  for (const task of record.retryableTasks) {
    if (!task || typeof task !== "object") continue;
    const value = task as {
      taskGid?: unknown;
      name?: unknown;
      projectName?: unknown;
      dueOn?: unknown;
    };
    if (typeof value.taskGid !== "string") continue;
    tasks.push({
      taskGid: value.taskGid,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.projectName === "string" ? { projectName: value.projectName } : {}),
      ...(typeof value.dueOn === "string" ? { dueOn: value.dueOn } : {})
    });
  }

  return {
    scopeLabel: typeof record.summary === "string" ? record.summary : undefined,
    tasks
  };
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

  return formatLocalDate(day);
}

export function matchAsanaDueTodayAndLatestOpenRequest(
  text: string,
  history: ResponseInputItem[],
  memoryEntries: PromptMemoryEntry[],
  timezone: string,
  baseDate = new Date()
): { dueOn: string; label: GenericAsanaTaskTarget } | null {
  const normalized = normalize(text);
  if (isLikelyAsanaWriteRequest(normalized)) return null;
  const asksForTodayTasks =
    /\b(today|tomorrow)\b/.test(normalized) &&
    (/\bimportant\b/.test(normalized) ||
      /\bmain\b/.test(normalized) ||
      /\bdue\b/.test(normalized) ||
      /\bshow\b/.test(normalized) ||
      /\bwhat\b/.test(normalized));
  const asksForLatestOpen =
    /\b(last|latest)\b/.test(normalized) &&
    /\bincomplete\b|\bopen\b/.test(normalized) &&
    /\btask\b/.test(normalized);

  if (!asksForTodayTasks || !asksForLatestOpen) return null;
  if (!isLikelyAsanaRequest(normalized, history, memoryEntries)) return null;

  const target = /\btomorrow\b/.test(normalized) ? "tomorrow" : "today";
  return {
    dueOn: asanaTaskDueDate(target, timezone, baseDate),
    label: target
  };
}

export function matchAsanaListShortcut(
  text: string,
  history: ResponseInputItem[],
  memoryEntries: PromptMemoryEntry[],
  timezone: string,
  baseDate = new Date()
): AsanaListShortcut | null {
  const normalized = normalize(text);
  if (isLikelyAsanaWriteRequest(normalized)) return null;
  if (!isLikelyAsanaRequest(normalized, history, memoryEntries)) return null;

  const scope = resolveScope(text, normalized, memoryEntries);
  const dateFilter = parseDateFilter(normalized, timezone, baseDate);
  const completed = parseCompletedSelection(normalized);
  const requestedLimit = parseLimit(normalized);
  const limit = requestedLimit ?? 50;
  const dateOnlyFollowUp =
    hasRecentAsanaContext(history, memoryEntries) &&
    !/\btasks?\b|\bmy tasks\b/.test(normalized) &&
    Boolean(dateFilter) &&
    isDateOnlyAsanaFollowUp(normalized);
  const wantsTaskList =
    /\btasks?\b/.test(normalized) ||
    /\bmy tasks\b/.test(normalized) ||
    /\bacross all projects\b/.test(normalized) ||
    /\bacross my tasks\b/.test(normalized) ||
    /\bdue\b/.test(normalized) ||
    /\boverdue\b|\bold tasks?\b|\bbacklog\b|\bstale\b/.test(normalized) ||
    /\bgo (?:all )?the way back\b|\bback to\b|\bsince\b|\bfrom\b/.test(normalized) ||
    dateOnlyFollowUp;

  if (!dateFilter || !wantsTaskList) return null;

  return {
    scope: scope.scope,
    project: scope.project,
    dueOn: dateFilter.dueOn,
    dueAfter: dateFilter.dueAfter,
    dueBefore: dateFilter.dueBefore,
    completed,
    sortBy: "due",
    sortDirection: "asc",
    limit,
    requestedLimit,
    label: dateFilter.label,
    emphasizeImportance: /\bimportant\b|\bmain\b/.test(normalized)
  };
}

export function matchAsanaLatestTaskShortcut(
  text: string,
  history: ResponseInputItem[],
  memoryEntries: PromptMemoryEntry[]
): AsanaLatestTaskShortcut | null {
  const normalized = normalize(text);
  if (isLikelyAsanaWriteRequest(normalized)) return null;
  if (!isLikelyAsanaRequest(normalized, history, memoryEntries)) return null;
  if (!/\b(last|latest)\b/.test(normalized)) return null;

  const scope = resolveScope(text, normalized, memoryEntries);
  const asksCompleted = /\bcompleted\b|\bdone\b|\bfinished\b/.test(normalized);
  const asksOpen = /\bincomplete\b|\bopen\b/.test(normalized);
  if (!asksCompleted && !asksOpen) return null;

  return {
    scope: scope.scope,
    project: scope.project,
    completed: asksCompleted,
    sortBy: asksCompleted ? "completedAt" : "modifiedAt",
    sortDirection: "desc",
    limit: 1,
    label: asksCompleted ? "latest completed" : "latest open"
  };
}

export function matchAmbiguousAsanaBulkCompleteRequest(
  text: string,
  memoryEntries: PromptMemoryEntry[]
): AsanaBulkCompleteClarification | null {
  const normalized = normalize(text);
  const asksToCompleteAll =
    /\bmark all tasks\b/.test(normalized) ||
    /\bcomplete all tasks\b/.test(normalized) ||
    /\bmark all of them\b/.test(normalized);
  const explicitScope =
    /\bacross all projects\b/.test(normalized) ||
    /\bin my tasks\b/.test(normalized) ||
    /\bthese tasks\b/.test(normalized) ||
    /\bthe listed tasks\b/.test(normalized) ||
    /\bin that project\b/.test(normalized) ||
    /\bin [a-z0-9 _-]+\b project/.test(normalized);

  if (!asksToCompleteAll || explicitScope) return null;

  const tasks = recentAsanaTasks(memoryEntries);
  if (!tasks.length) return null;

  return {
    taskCount: tasks.length,
    projectName: singleProjectNameFromTasks(tasks)
  };
}

export function formatAsanaTaskOverview(
  tasks: AsanaTaskSummary[],
  label: GenericAsanaTaskTarget
): string {
  return formatScopedAsanaTaskList(tasks, {
    label: `due ${label}`,
    emptyLabel: `I don't see any open Asana tasks due ${label}.`,
    emphasizeImportance: false
  });
}

export function formatScopedAsanaTaskList(
  tasks: AsanaTaskSummary[],
  input: {
    label: string;
    emptyLabel: string;
    scopeName?: string;
    completed?: boolean;
    displayLimit?: number;
    emphasizeImportance?: boolean;
  }
): string {
  if (!tasks.length) return input.emptyLabel;

  const statusLabel = input.completed ? "completed" : "open";
  const intro = input.emphasizeImportance
    ? `Here are the ${statusLabel} Asana tasks I can see ${input.label}${input.scopeName ? ` in ${input.scopeName}` : ""}. I can't reliably rank importance from Asana alone, so I'm listing them with context:`
    : `Here are the ${statusLabel} Asana tasks ${input.label}${input.scopeName ? ` in ${input.scopeName}` : ""}:`;

  const displayLimit = Math.min(Math.max(input.displayLimit ?? 20, 1), 50);
  const visibleTasks = tasks.slice(0, displayLimit);
  const body = visibleTasks
    .map((task, index) => `${index + 1}. ${formatTaskLine(task)}`)
    .join("\n");

  const truncation =
    tasks.length > visibleTasks.length
      ? `\n\nShowing first ${visibleTasks.length} of ${tasks.length} returned tasks.`
      : "";

  return `${intro}\n\n${body}${truncation}`;
}

export function formatLatestAsanaTaskReply(
  task: AsanaTaskSummary | null,
  input: {
    label: string;
    timezone: string;
    scopeName?: string;
    completed: boolean;
  }
): string {
  if (!task) {
    return input.completed
      ? `I don't see a completed Asana task for that request${input.scopeName ? ` in ${input.scopeName}` : ""}.`
      : `I don't see an open Asana task for that request${input.scopeName ? ` in ${input.scopeName}` : ""}.`;
  }

  const timestamp =
    (input.completed ? task.completedAt : task.modifiedAt) ?? task.modifiedAt ?? task.createdAt;
  const timestampLabel = input.completed
    ? "Completed"
    : task.modifiedAt
      ? "Last updated"
      : "Created";
  const projectLabel = firstProjectLabel(task);

  return [
    `${capitalize(input.label)} Asana task${input.scopeName ? ` in ${input.scopeName}` : ""}:`,
    "",
    `• ${task.name}${projectLabel ? ` (${projectLabel})` : ""}`,
    timestamp ? `• ${timestampLabel}: ${formatForUser(timestamp, input.timezone)}` : undefined,
    task.createdAt && task.createdAt !== timestamp
      ? `• Created: ${formatForUser(task.createdAt, input.timezone)}`
      : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatAsanaTodayAndLatestOpenReply(
  todayTasks: AsanaTaskSummary[],
  latestOpenTask: AsanaTaskSummary | null,
  timezone: string,
  label: GenericAsanaTaskTarget
): string {
  const sections = [
    formatScopedAsanaTaskList(todayTasks, {
      label: `due ${label}`,
      emptyLabel: `I don't see any open Asana tasks due ${label}.`,
      emphasizeImportance: true
    }),
    formatLatestAsanaTaskReply(latestOpenTask, {
      label: "latest open",
      timezone,
      completed: false
    })
  ];

  return sections.join("\n\n");
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ");
}

function normalizeIntentText(text: string): string {
  return normalize(text)
    .replace(/[.?!…]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNamedTaskCreations(text: string): string[] {
  const markerPattern =
    /\b(?:first\s+|another\s+|and\s+another\s+|one\s+more\s+|also\s+)?(?:add(?:ed)?\s+)?(?:a\s+)?task\s+(?:called|named|titled)\s*[:.,-]?\s*/gi;
  const matches = Array.from(text.matchAll(markerPattern));
  if (matches.length < 2) return [];

  const names: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    const segment = text.slice(start, end);
    const name = cleanupCreatedTaskName(resolveCorrectionInCreatedTaskName(segment));
    if (name) names.push(name);
  }

  return names;
}

function resolveCorrectionInCreatedTaskName(segment: string): string {
  const correction = segment.match(
    /\b(?:actually|no|wait|sorry)\s+(?:change|changed|switch|make|rename|name)\s+(?:that|it|this)?\s*(?:to|as)?\s+(.+)$/i
  );
  return correction?.[1] ?? segment;
}

function cleanupCreatedTaskName(value: string): string | null {
  const cleaned = value
    .replace(/\b(?:due|deadline|by|on|before|after)\s+.*$/i, "")
    .replace(/\b(?:please|thanks?|thank you|yeah|yep|ok|okay|um|uh)\b/gi, " ")
    .replace(/^["'`.,:;\s-]+|["'`.,:;\s-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 2) return null;
  return cleaned;
}

function parseCreateDueOn(
  normalizedText: string,
  timezone: string,
  baseDate: Date
): string | undefined {
  if (/\b(?:no due date|without (?:a |any )?due date|no deadline)\b/.test(normalizedText)) {
    return undefined;
  }
  if (/\bdue\s+(?:today|tonight)\b|\btasks?\s+due\s+(?:today|tonight)\b/.test(normalizedText)) {
    return asanaTaskDueDate("today", timezone, baseDate);
  }
  if (
    /\bdue\s+(?:tomorrow|tmr|tmrw)\b|\btasks?\s+due\s+(?:tomorrow|tmr|tmrw)\b/.test(normalizedText)
  ) {
    return asanaTaskDueDate("tomorrow", timezone, baseDate);
  }
  const isoDue = normalizedText.match(/\bdue\s+(\d{4}-\d{2}-\d{2})\b/);
  return isoDue?.[1];
}

function extractDueDateUpdateTaskName(text: string): string | undefined {
  const source = text
    .replace(/[’]/g, "'")
    .replace(/\.{2,}|…/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let working = source.replace(
    /^\s*(?:please\s+)?(?:move|change|update|set|make|reschedule)\s+/i,
    ""
  );

  const dueDateOfMatch = working.match(/\bdue\s+date\s+(?:of|for|on)\s+(.+?)\s+(?:to|for|on)\s+/i);
  if (dueDateOfMatch?.[1]) {
    return cleanupDueDateUpdateTaskName(dueDateOfMatch[1]);
  }

  const cutPatterns = [
    /\s+(?:asana\s+)?tasks?\b/i,
    /\s+due\s+date\b/i,
    /\s+(?:to\s+be\s+)?due\b/i,
    /\s+(?:to|for|on)\s+(?:today|tonight|tomorrow|tmr|tmrw|yesterday)\b/i,
    /\s+(?:to|for|on)\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i,
    new RegExp(`\\s+(?:to|for|on)\\s+(?:${MONTH_DAY_REFERENCE_PATTERN})\\b`, "i"),
    /\s+from\s*$/i
  ];

  for (const pattern of cutPatterns) {
    const match = working.match(pattern);
    if (match?.index !== undefined && match.index >= 0) {
      working = working.slice(0, match.index);
      break;
    }
  }

  return cleanupDueDateUpdateTaskName(working);
}

function cleanupDueDateUpdateTaskName(value: string): string | undefined {
  const cleaned = value
    .replace(/^(?:my|the|this|that)\s+/i, "")
    .replace(/\b(?:asana|task|tasks)\b/gi, " ")
    .replace(/^["'`.,:;\s-]+|["'`.,:;\s-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 2 ? cleaned : undefined;
}

function parseDueDateUpdateTarget(
  normalizedText: string,
  timezone: string,
  baseDate: Date
): string | null | undefined {
  if (
    /\b(?:no due date|without (?:a |any )?due date|no deadline|remove (?:the )?due date)\b/.test(
      normalizedText
    )
  ) {
    return null;
  }
  if (/\b(?:today|tonight)\b/.test(normalizedText)) {
    return asanaTaskDueDate("today", timezone, baseDate);
  }
  if (/\b(?:tomorrow|tmr|tmrw)\b/.test(normalizedText)) {
    return asanaTaskDueDate("tomorrow", timezone, baseDate);
  }
  if (/\byesterday\b/.test(normalizedText)) {
    return relativeDateIso(timezone, -1, baseDate);
  }

  const dateMatch = normalizedText.match(
    new RegExp(
      `\\b(?:due|to|for|on)\\s+(${MONTH_DAY_REFERENCE_PATTERN}|${ISO_DATE_REFERENCE_PATTERN}|${SLASH_DATE_REFERENCE_PATTERN})\\b`
    )
  );
  if (dateMatch?.[1]) {
    return parseDateReference(dateMatch[1], timezone, baseDate)?.iso;
  }

  return undefined;
}

function isLikelyAsanaWriteRequest(normalizedText: string): boolean {
  const intentText = normalizeIntentText(normalizedText);
  const mentionsTask = /\b(tasks?|asana)\b/.test(intentText);
  const createTask =
    /\b(create|add|make|set up)\b.*\btasks?\b/.test(intentText) ||
    /\btasks?\b.*\b(create|add|make|set up)\b/.test(intentText);
  const mutateTask =
    /\b(delete|remove|trash|update|rename|change|move|reschedule)\b.*\btasks?\b/.test(intentText) ||
    /\btasks?\b.*\b(delete|remove|trash|update|rename|change|move|reschedule)\b/.test(intentText);
  const completeTask =
    /\b(mark|set)\b.*\btasks?\b.*\b(complete|done|incomplete|open)\b/.test(intentText) ||
    /\b(complete|finish)\b.*\btasks?\b/.test(intentText);

  return mentionsTask && (createTask || mutateTask || completeTask);
}

function isLikelyAsanaRequest(
  normalizedText: string,
  history: ResponseInputItem[],
  memoryEntries: PromptMemoryEntry[]
): boolean {
  if (/\basana\b/.test(normalizedText)) return true;
  if (/\bmy tasks\b|\btasks?\b/.test(normalizedText)) return true;
  if (!hasRecentAsanaContext(history, memoryEntries)) return false;
  return (
    /\bbefore yesterday\b/.test(normalizedText) ||
    /\b(overdue|old tasks?|backlog|stale|before today|back to|go (?:all )?the way back)\b/.test(
      normalizedText
    ) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(normalizedText) ||
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(normalizedText) ||
    /\b(latest|last)\b/.test(normalizedText) ||
    /\b(apr|april|jan|january|feb|february|mar|march|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/.test(
      normalizedText
    ) ||
    /\b(today|tomorrow|yesterday)\b/.test(normalizedText)
  );
}

function hasRecentAsanaContext(
  history: ResponseInputItem[],
  memoryEntries: PromptMemoryEntry[]
): boolean {
  if (memoryEntries.some((entry) => entry.key.startsWith("recent_asana_"))) return true;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.role !== "assistant") continue;
    const content = typeof item.content === "string" ? item.content.toLowerCase() : "";
    if (isAsanaAssistantContext(content)) return true;
  }

  return false;
}

function isAsanaAssistantContext(normalizedContent: string): boolean {
  return (
    /\bopen asana tasks?\b/.test(normalizedContent) ||
    /\basana tasks? (?:due|in|matched|i can see)\b/.test(normalizedContent) ||
    /\b(?:latest|last)(?:\s+(?:open|completed))?\s+asana task\b/.test(normalizedContent) ||
    /\b(?:open|completed)\s+asana task\b/.test(normalizedContent) ||
    /\byour asana projects?\b/.test(normalizedContent) ||
    /\bfound \d+ asana (?:task|tasks|project|projects|workspace|workspaces|team|teams)\b/.test(
      normalizedContent
    ) ||
    /\basana workspace\b/.test(normalizedContent) ||
    /\b(?:created|updated|deleted) asana task\b/.test(normalizedContent)
  );
}

function isDateOnlyAsanaFollowUp(normalizedText: string): boolean {
  const compact = normalizedText
    .replace(/[?.!]+$/g, "")
    .replace(/^(?:ok|okay|yeah|yes|yep|sure)[,\s]+/, "")
    .trim();
  return DATE_ONLY_FOLLOW_UP_PATTERN.test(compact);
}

function resolveScope(
  text: string,
  normalizedText: string,
  memoryEntries: PromptMemoryEntry[]
): { scope: "my_tasks" | "project"; project?: ResolvedAsanaProjectShortcut } {
  if (/\bacross all projects\b|\bacross my tasks\b|\ball projects\b/.test(normalizedText)) {
    return { scope: "my_tasks" };
  }

  const projectName = extractProjectNameFromTaskListText(text);
  if (projectName) {
    const project = resolveRecentProjectByName(projectName, memoryEntries);
    return { scope: "project", project: project ?? { name: projectName } };
  }

  const project = resolveRecentProjectFromExplicitText(normalizedText, memoryEntries);
  if (project) {
    return { scope: "project", project };
  }

  return { scope: "my_tasks" };
}

function parseDateFilter(
  normalizedText: string,
  timezone: string,
  baseDate: Date
): { dueOn?: string; dueAfter?: string; dueBefore?: string; label: string } | null {
  if (/\b(?:overdue|old tasks?|backlog|stale)\b/.test(normalizedText)) {
    const lowerBound = parseLowerBoundDateReference(normalizedText, timezone, baseDate);
    const explicitBefore = parseExplicitBeforeDateReference(normalizedText, timezone, baseDate);
    return {
      ...(lowerBound ? { dueAfter: lowerBound.iso } : {}),
      dueBefore: explicitBefore?.inclusiveBeforeIso ?? relativeDateIso(timezone, -1, baseDate),
      label: lowerBound
        ? `overdue from ${lowerBound.displayLabel}`
        : explicitBefore
          ? `overdue before ${explicitBefore.displayLabel}`
          : "overdue"
    };
  }

  if (/\bbefore\s+today\b/.test(normalizedText)) {
    return {
      dueBefore: relativeDateIso(timezone, -1, baseDate),
      label: "due before today"
    };
  }

  if (/\bbefore yesterday\b/.test(normalizedText)) {
    return {
      dueBefore: relativeDateIso(timezone, -2, baseDate),
      label: "due before yesterday"
    };
  }

  const explicitBefore = parseExplicitBeforeDateReference(normalizedText, timezone, baseDate);
  if (explicitBefore) {
    return {
      dueBefore: explicitBefore.inclusiveBeforeIso,
      label: `due before ${explicitBefore.displayLabel}`
    };
  }

  const lowerBound = parseLowerBoundDateReference(normalizedText, timezone, baseDate);
  if (lowerBound) {
    return {
      dueAfter: lowerBound.iso,
      dueBefore: relativeDateIso(timezone, -1, baseDate),
      label: `overdue from ${lowerBound.displayLabel}`
    };
  }

  if (/\btoday\b/.test(normalizedText)) {
    return {
      dueOn: asanaTaskDueDate("today", timezone, baseDate),
      label: "due today"
    };
  }

  if (/\btomorrow\b/.test(normalizedText)) {
    return {
      dueOn: asanaTaskDueDate("tomorrow", timezone, baseDate),
      label: "due tomorrow"
    };
  }

  const monthDay = parseMonthDayReference(normalizedText, timezone, baseDate);
  if (monthDay) {
    if (/\bbefore\b/.test(normalizedText)) {
      return {
        dueBefore: shiftDateIso(monthDay.iso, -1),
        label: `due before ${monthDay.displayLabel}`
      };
    }

    return {
      dueOn: monthDay.iso,
      label: `due on ${monthDay.displayLabel}`
    };
  }

  const absoluteDate = parseAbsoluteDateReference(normalizedText, timezone, baseDate);
  if (absoluteDate) {
    return {
      dueOn: absoluteDate.iso,
      label: `due on ${absoluteDate.displayLabel}`
    };
  }

  return null;
}

function parseCompletedSelection(normalizedText: string): boolean | undefined {
  if (/\bcompleted\b|\bdone\b|\bfinished\b/.test(normalizedText)) return true;
  return false;
}

function parseLimit(normalizedText: string): number | undefined {
  const match = normalizedText.match(/\blimit\s+(\d{1,3})\b/);
  if (!match?.[1]) return undefined;
  return Math.min(Math.max(Number.parseInt(match[1], 10), 1), 100);
}

function parseExplicitBeforeDateReference(
  normalizedText: string,
  timezone: string,
  baseDate: Date
): { inclusiveBeforeIso: string; displayLabel: string } | null {
  const match = normalizedText.match(
    new RegExp(
      `\\bbefore\\s+(${MONTH_DAY_REFERENCE_PATTERN}|${ISO_DATE_REFERENCE_PATTERN}|${SLASH_DATE_REFERENCE_PATTERN})\\b`
    )
  );
  if (!match?.[1]) return null;
  const parsed = parseDateReference(match[1], timezone, baseDate);
  if (!parsed) return null;
  return {
    inclusiveBeforeIso: shiftDateIso(parsed.iso, -1),
    displayLabel: parsed.displayLabel
  };
}

function parseLowerBoundDateReference(
  normalizedText: string,
  timezone: string,
  baseDate: Date
): { iso: string; displayLabel: string } | null {
  const match = normalizedText.match(
    new RegExp(
      `\\b(?:from|since|back\\s+to|go\\s+(?:all\\s+)?the\\s+way\\s+back\\s+to)\\s+(${MONTH_DAY_REFERENCE_PATTERN}|${ISO_DATE_REFERENCE_PATTERN}|${SLASH_DATE_REFERENCE_PATTERN})\\b`
    )
  );
  return match?.[1] ? parseDateReference(match[1], timezone, baseDate) : null;
}

function parseAbsoluteDateReference(
  normalizedText: string,
  timezone: string,
  baseDate: Date
): { iso: string; displayLabel: string } | null {
  const match = normalizedText.match(
    new RegExp(`\\b(${ISO_DATE_REFERENCE_PATTERN}|${SLASH_DATE_REFERENCE_PATTERN})\\b`)
  );
  return match?.[1] ? parseDateReference(match[1], timezone, baseDate) : null;
}

function parseDateReference(
  value: string,
  timezone: string,
  baseDate: Date
): { iso: string; displayLabel: string } | null {
  return (
    parseMonthDayReference(value, timezone, baseDate) ??
    parseIsoDateReference(value) ??
    parseSlashDateReference(value, timezone, baseDate)
  );
}

function parseMonthDayReference(
  normalizedText: string,
  timezone: string,
  baseDate: Date
): { iso: string; displayLabel: string } | null {
  const match = normalizedText.match(
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(\d{4}))?\b/
  );
  if (!match) return null;

  const monthName = match[1];
  const month = monthName ? MONTH_INDEX[monthName] : undefined;
  if (month === undefined) return null;
  const dayPart = match[2];
  if (!dayPart) return null;
  const day = Number.parseInt(dayPart, 10);
  const currentYear = Number.parseInt(formatInTimeZone(baseDate, timezone, "yyyy"), 10);
  const year = match[3] ? Number.parseInt(match[3], 10) : currentYear;
  const monthLabel = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ][month];

  return {
    iso: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    displayLabel: `${monthLabel} ${day}`
  };
}

function parseIsoDateReference(value: string): { iso: string; displayLabel: string } | null {
  const match = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    iso: `${match[1]}-${match[2]}-${match[3]}`,
    displayLabel: `${match[1]}-${match[2]}-${match[3]}`
  };
}

function parseSlashDateReference(
  value: string,
  timezone: string,
  baseDate: Date
): { iso: string; displayLabel: string } | null {
  const match = value.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (!match?.[1] || !match[2]) return null;
  const month = Number.parseInt(match[1], 10);
  const day = Number.parseInt(match[2], 10);
  const currentYear = Number.parseInt(formatInTimeZone(baseDate, timezone, "yyyy"), 10);
  const year = match[3]
    ? Number.parseInt(match[3].length === 2 ? `20${match[3]}` : match[3], 10)
    : currentYear;

  if (month < 1 || month > 12 || day < 1 || day > 31 || !Number.isFinite(year)) return null;

  return {
    iso: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    displayLabel: `${month}/${day}/${String(year).slice(-2)}`
  };
}

function relativeDateIso(timezone: string, offsetDays: number, baseDate: Date): string {
  const zoned = toZonedTime(baseDate, timezone);
  const day = new Date(zoned);
  day.setDate(day.getDate() + offsetDays);
  return formatLocalDate(day);
}

function shiftDateIso(value: string, offsetDays: number): string {
  const parts = value.split("-");
  if (parts.length !== 3) return value;
  const year = Number.parseInt(parts[0] ?? "", 10);
  const month = Number.parseInt(parts[1] ?? "", 10);
  const day = Number.parseInt(parts[2] ?? "", 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return value;
  }
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function recentAsanaProjects(memoryEntries: PromptMemoryEntry[]): ResolvedAsanaProjectShortcut[] {
  const entry = memoryEntries.find((item) => item.key === "recent_asana_projects");
  if (!entry || !Array.isArray(entry.value)) return [];

  return entry.value
    .map((value): ResolvedAsanaProjectShortcut | null => {
      if (
        !value ||
        typeof value !== "object" ||
        typeof (value as { projectGid?: unknown }).projectGid !== "string"
      ) {
        return null;
      }
      return {
        projectGid: (value as { projectGid: string }).projectGid,
        name:
          typeof (value as { name?: unknown }).name === "string"
            ? (value as { name: string }).name
            : "(Untitled project)"
      };
    })
    .filter((value): value is ResolvedAsanaProjectShortcut => value !== null);
}

function resolveRecentProjectByName(
  projectName: string,
  memoryEntries: PromptMemoryEntry[]
): ResolvedAsanaProjectShortcut | null {
  const normalizedProjectName = normalize(projectName);
  return (
    recentAsanaProjects(memoryEntries).find(
      (project) => normalize(project.name) === normalizedProjectName
    ) ?? null
  );
}

function resolveRecentProjectFromExplicitText(
  normalizedText: string,
  memoryEntries: PromptMemoryEntry[]
): ResolvedAsanaProjectShortcut | null {
  const candidates = recentAsanaProjects(memoryEntries).filter((project) => {
    const name = escapeRegExp(project.name.toLowerCase());
    return (
      new RegExp(
        `\\b(?:in|inside|under|from|for)\\s+(?:the\\s+)?(?:asana\\s+)?project\\s+${name}\\b`
      ).test(normalizedText) ||
      new RegExp(`\\b(?:in|inside|under|from|for)\\s+(?:the\\s+)?${name}\\s+project\\b`).test(
        normalizedText
      ) ||
      new RegExp(`\\btasks?\\s+in\\s+${name}\\b`).test(normalizedText)
    );
  });

  if (!candidates.length) return null;
  candidates.sort((left, right) => right.name.length - left.name.length);
  return candidates[0] ?? null;
}

function extractProjectNameFromTaskListText(text: string): string | null {
  const patterns = [
    /\b(?:show|list|check|read)\b[^.?!]*\btasks?\s+in\s+(?:project\s+)?([a-z0-9][a-z0-9 _-]{1,80})\b/i,
    /\b(?:show|list|check|read)\b[^.?!]*\bproject\s+([a-z0-9][a-z0-9 _-]{1,80})\s+tasks?\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const projectName = cleanupProjectName(match?.[1]);
    if (projectName) return projectName;
  }

  return null;
}

function cleanupProjectName(value: string | undefined): string | null {
  const cleaned = value
    ?.replace(
      /\b(?:due|before|after|from|since|overdue|open|incomplete|completed|complete|sorted|limit)\b.*$/i,
      ""
    )
    .trim();
  return cleaned || null;
}

function recentAsanaTasks(memoryEntries: PromptMemoryEntry[]): Array<{
  taskGid: string;
  name?: string;
  projectName?: string;
}> {
  const entry = memoryEntries.find((item) => item.key === "recent_asana_tasks");
  if (!entry || !Array.isArray(entry.value)) return [];

  const tasks: Array<{ taskGid: string; name?: string; projectName?: string }> = [];

  for (const value of entry.value) {
    if (!value || typeof value !== "object") continue;
    const taskGid =
      typeof (value as { taskGid?: unknown }).taskGid === "string"
        ? (value as { taskGid: string }).taskGid
        : null;
    if (!taskGid) continue;

    tasks.push({
      taskGid,
      name:
        typeof (value as { name?: unknown }).name === "string"
          ? (value as { name: string }).name
          : undefined,
      projectName:
        typeof (value as { projectName?: unknown }).projectName === "string"
          ? (value as { projectName: string }).projectName
          : undefined
    });
  }

  return tasks;
}

function singleProjectNameFromTasks(
  tasks: Array<{ taskGid: string; name?: string; projectName?: string }>
): string | undefined {
  const names = Array.from(
    new Set(
      tasks.map((task) => task.projectName).filter((value): value is string => Boolean(value))
    )
  );
  return names.length === 1 ? names[0] : undefined;
}

function normalizeCompletionText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\w\s,'"&-]/g, " ")
    .replace(/\s+/g, " ");
}

function asksToCompleteAsanaTask(normalizedText: string): boolean {
  const asksComplete =
    /\b(?:complete|finish)\b/.test(normalizedText) ||
    /\bmark\b.*\b(?:complete|done|finished)\b/.test(normalizedText) ||
    /\bset\b.*\b(?:complete|done|finished)\b/.test(normalizedText);
  if (!asksComplete) return false;
  return (
    /\basana\b|\btasks?\b|\bit\b|\bthat\b|\bthose\b|\bthese\b|\bthem\b|\bones?\b|\bitems?\b|\bcluster\b/.test(
      normalizedText
    ) || /\b(?:first|second|third|fourth|fifth|\d{1,2})\b/.test(normalizedText)
  );
}

function isBroadAsanaCompletionRequest(normalizedText: string): boolean {
  if (referencesAllListedTasks(normalizedText)) return false;
  if (/\bcluster\b/.test(normalizedText)) return false;
  return (
    /\b(?:all|every)\s+(?:open\s+|incomplete\s+|overdue\s+)?(?:asana\s+)?tasks?\b/.test(
      normalizedText
    ) ||
    /\bcomplete\s+(?:all|every)\b/.test(normalizedText) ||
    /\bmark\s+(?:all|every)\b.*\b(?:complete|done|finished)\b/.test(normalizedText)
  );
}

function referencesClusterCompletionTarget(normalizedText: string): boolean {
  return /\bcluster\b/.test(normalizedText) && /\b(?:complete|mark|finish)\b/.test(normalizedText);
}

function hasLegacyRecentAsanaTasks(memoryEntries: PromptMemoryEntry[]): boolean {
  return memoryEntries.some((entry) => entry.key === "recent_asana_tasks");
}

function isFreshAsanaTaskList(list: LastVisibleAsanaTaskList, now: Date): boolean {
  const timestamp = list.updatedAt ?? (list.createdAt ? new Date(list.createdAt) : null);
  if (!timestamp || Number.isNaN(timestamp.getTime())) return false;
  return now.getTime() - timestamp.getTime() <= LAST_VISIBLE_ASANA_TASK_LIST_FRESH_MS;
}

function referencesAllListedTasks(normalizedText: string): boolean {
  return (
    /\b(?:those|these|them)\b/.test(normalizedText) ||
    /\blisted\s+tasks?\b|\btasks?\s+listed\b|\bshown\s+tasks?\b|\btasks?\s+shown\b/.test(
      normalizedText
    ) ||
    /\b(?:the|that|this)\s+list\b/.test(normalizedText)
  );
}

function referencesSingleRecentTask(normalizedText: string): boolean {
  return (
    /\b(?:that|this)\s+(?:asana\s+)?tasks?\b/.test(normalizedText) ||
    /\b(?:mark|complete|finish|set)\s+(?:it|that|this)\b/.test(normalizedText) ||
    /\b(?:it|that|this)\s+(?:as\s+)?(?:complete|done|finished)\b/.test(normalizedText)
  );
}

function extractAsanaListClauseBeforeCompletion(text: string): string | null {
  const clauses = text
    .split(/[.!?;\n]+|\bthen\b|\band then\b/i)
    .map((clause) => clause.trim())
    .filter(Boolean);

  for (const clause of clauses) {
    const stripped = stripCompletionTail(clause);
    const normalized = normalizeCompletionText(stripped);
    if (/\b(?:show|list|check|read)\b/.test(normalized) && /\btasks?\b/.test(normalized)) {
      return stripped;
    }
  }

  const stripped = stripCompletionTail(text);
  const normalized = normalizeCompletionText(stripped);
  if (/\b(?:show|list|check|read)\b/.test(normalized) && /\btasks?\b/.test(normalized)) {
    return stripped;
  }

  return null;
}

function stripCompletionTail(text: string): string {
  return text
    .replace(
      /\b(?:and\s+)?(?:mark|complete|finish|set)\b[\s\S]*\b(?:complete|done|finished|tasks?)\b[\s\S]*$/i,
      ""
    )
    .trim();
}

function resolveFirstShownCompletionTargets(
  normalizedText: string,
  tasks: LastVisibleAsanaTaskList["tasks"]
): LastVisibleAsanaTaskList["tasks"] | "too_many" | "out_of_range" {
  const match = normalizedText.match(
    /\b(?:first|top)\s+(\d{1,2})\s+(?:shown|listed|tasks?|items?|ones?)\b/
  );
  if (!match?.[1]) return [];

  const count = Number.parseInt(match[1], 10);
  if (count > 25) return "too_many";
  if (count < 1 || count > tasks.length) return "out_of_range";
  return tasks.slice(0, count);
}

function resolveOrdinalCompletionTargets(
  normalizedText: string,
  tasks: LastVisibleAsanaTaskList["tasks"]
): LastVisibleAsanaTaskList["tasks"] | "out_of_range" {
  const indices = new Set<number>();
  const explicitNumberGroup = normalizedText.match(
    /\b(?:tasks?|items?|ones?)\s+((?:\d{1,2}\s*(?:,|and|&)?\s*){1,10})\b/
  );
  if (explicitNumberGroup?.[1]) {
    for (const match of explicitNumberGroup[1].matchAll(/\d{1,2}/g)) {
      indices.add(Number.parseInt(match[0], 10));
    }
  }

  const ordinalWords: Record<string, number> = {
    first: 1,
    "1st": 1,
    second: 2,
    "2nd": 2,
    third: 3,
    "3rd": 3,
    fourth: 4,
    "4th": 4,
    fifth: 5,
    "5th": 5,
    sixth: 6,
    "6th": 6,
    seventh: 7,
    "7th": 7,
    eighth: 8,
    "8th": 8,
    ninth: 9,
    "9th": 9,
    tenth: 10,
    "10th": 10
  };
  for (const [word, index] of Object.entries(ordinalWords)) {
    if (new RegExp(`\\b${word}\\s+(?:tasks?|items?|ones?)?\\b`).test(normalizedText)) {
      indices.add(index);
    }
  }

  if (!indices.size) return [];
  const selected: LastVisibleAsanaTaskList["tasks"] = [];
  for (const index of Array.from(indices).sort((left, right) => left - right)) {
    if (index < 1 || index > tasks.length) return "out_of_range";
    selected.push(tasks[index - 1]!);
  }
  return selected;
}

function resolveNamedCompletionTargets(
  normalizedText: string,
  tasks: LastVisibleAsanaTaskList["tasks"]
): LastVisibleAsanaTaskList["tasks"] | "ambiguous" {
  const matches = tasks.filter((task) => {
    if (!task.name || task.name.trim().length < 3) return false;
    const normalizedName = normalizeCompletionText(task.name);
    return new RegExp(`(^|\\b)${escapeRegExp(normalizedName)}(\\b|$)`).test(normalizedText);
  });
  if (!matches.length) return [];

  const matchedNames = new Set(matches.map((task) => normalizeCompletionText(task.name ?? "")));
  if (
    matches.length > 1 &&
    matchedNames.size === 1 &&
    !/\b(?:all|both|those|these)\b/.test(normalizedText)
  ) {
    return "ambiguous";
  }
  return matches;
}

function resolveExplicitPastedCompletionTargets(
  text: string,
  tasks: LastVisibleAsanaTaskList["tasks"]
): LastVisibleAsanaTaskList["tasks"] | { unresolved: string[] } | "too_many" | null {
  const requests = extractPastedAsanaTaskLines(text);
  if (!requests.length) return null;
  if (requests.length > 25) return "too_many";

  const selected: LastVisibleAsanaTaskList["tasks"] = [];
  const unresolved: string[] = [];
  const usedGids = new Set<string>();

  for (const request of requests) {
    const candidates = tasks.filter((task) => pastedTaskMatchesReference(request, task, usedGids));
    if (!candidates.length) {
      unresolved.push(formatPastedTaskRequest(request));
      continue;
    }

    candidates.sort((left, right) => {
      const leftScore = pastedTaskMatchScore(request, left);
      const rightScore = pastedTaskMatchScore(request, right);
      return rightScore - leftScore;
    });
    const selectedTask = candidates[0]!;
    selected.push(selectedTask);
    usedGids.add(selectedTask.taskGid);
  }

  if (unresolved.length) return { unresolved };
  return selected;
}

function extractPastedAsanaTaskLines(text: string): Array<{
  name: string;
  projectName?: string;
  dueOn?: string;
}> {
  const requests: Array<{ name: string; projectName?: string; dueOn?: string }> = [];
  const pattern = /([^()\n\r]{2,140}?)\s*\(([^()\n\r]*?)\s*[•·-]\s*due\s+(\d{4}-\d{2}-\d{2})\)/g;

  for (const match of text.matchAll(pattern)) {
    const name = cleanupPastedAsanaTaskName(match[1] ?? "");
    const dueOn = match[3];
    if (!name || !dueOn) continue;
    const projectName = cleanupPastedAsanaProjectName(match[2] ?? "");
    requests.push({
      name,
      ...(projectName ? { projectName } : {}),
      dueOn
    });
  }

  return requests;
}

function cleanupPastedAsanaTaskName(value: string): string | null {
  const cleaned = value
    .replace(/[\u2000-\u206F\uFEFF]/g, " ")
    .replace(/^.*?\bmark\s+these\s+complete\s*:\s*/i, "")
    .replace(/^.*?\bmark\s+all\s+these\s+(?:as\s+)?complete\s*:\s*/i, "")
    .replace(/^\s*(?:[-*•]\s*)?\d{1,2}[.)]?\s*/g, "")
    .replace(/^["'`.,:;\s-]+|["'`.,:;\s-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}

function cleanupPastedAsanaProjectName(value: string): string | null {
  const cleaned = value
    .replace(/[\u2000-\u206F\uFEFF]/g, " ")
    .replace(/\bno project\b/i, "")
    .replace(/^["'`.,:;\s-]+|["'`.,:;\s-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function pastedTaskMatchesReference(
  request: { name: string; projectName?: string; dueOn?: string },
  task: LastVisibleAsanaTaskList["tasks"][number],
  usedGids: Set<string>
): boolean {
  if (usedGids.has(task.taskGid)) return false;
  if (!task.name) return false;
  if (normalizeCompletionText(task.name) !== normalizeCompletionText(request.name)) return false;
  if (request.dueOn && task.dueOn !== request.dueOn) return false;
  if (
    request.projectName &&
    normalizeCompletionText(task.projectName ?? "") !== normalizeCompletionText(request.projectName)
  ) {
    return false;
  }
  return true;
}

function pastedTaskMatchScore(
  request: { projectName?: string; dueOn?: string },
  task: LastVisibleAsanaTaskList["tasks"][number]
): number {
  let score = 1;
  if (request.dueOn && task.dueOn === request.dueOn) score += 2;
  if (
    request.projectName &&
    normalizeCompletionText(task.projectName ?? "") === normalizeCompletionText(request.projectName)
  ) {
    score += 2;
  }
  return score;
}

function formatPastedTaskRequest(request: {
  name: string;
  projectName?: string;
  dueOn?: string;
}): string {
  const details = [request.projectName, request.dueOn ? `due ${request.dueOn}` : undefined]
    .filter(Boolean)
    .join(" • ");
  return `${request.name}${details ? ` (${details})` : ""}`;
}

function formatTaskLine(task: AsanaTaskSummary): string {
  const details: string[] = [];
  const project = firstProjectLabel(task);
  if (project) details.push(project);
  if (task.dueAt) {
    details.push(`due ${task.dueAt.slice(11, 16)}`);
  } else if (task.dueOn) {
    details.push(`due ${task.dueOn}`);
  }

  return details.length ? `${task.name} (${details.join(" • ")})` : task.name;
}

function firstProjectLabel(task: AsanaTaskSummary): string | undefined {
  const projectName = task.projects?.find((project) => project.name)?.name;
  return projectName ?? (task.workspaceName && !task.projects?.length ? "No project" : undefined);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatLocalDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
    value.getDate()
  ).padStart(2, "0")}`;
}
