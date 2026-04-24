import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import type { ResponseInputItem } from "../../lib/openaiClient";
import { formatForUser } from "../../lib/time";
import type { AsanaTaskSummary } from "../asana/asanaTypes";
import type { PromptMemoryEntry } from "./conversationContext";

export type GenericAsanaTaskTarget = "today" | "tomorrow";

export interface ResolvedAsanaProjectShortcut {
  projectGid: string;
  name: string;
}

export interface AsanaListShortcut {
  scope: "my_tasks" | "project";
  project?: ResolvedAsanaProjectShortcut;
  dueOn?: string;
  dueBefore?: string;
  completed?: boolean;
  sortBy?: "due" | "createdAt" | "modifiedAt" | "completedAt";
  sortDirection?: "asc" | "desc";
  limit: number;
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

export interface AsanaBulkCompleteClarification {
  taskCount: number;
  projectName?: string;
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
const DATE_ONLY_FOLLOW_UP_PATTERN = new RegExp(
  `^(?:(?:what|how)\\s+about\\s+|and\\s+|for\\s+|from\\s+|on\\s+|due\\s+)?(?:before\\s+yesterday|today|tomorrow|yesterday|${MONTH_DAY_REFERENCE_PATTERN}|before\\s+${MONTH_DAY_REFERENCE_PATTERN})$`
);

export function matchGenericAsanaMyTasksRequest(
  text: string
): GenericAsanaTaskTarget | null {
  const normalized = normalize(text);
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
  if (!isLikelyAsanaRequest(normalized, history, memoryEntries)) return null;

  const scope = resolveScope(normalized, memoryEntries);
  const dateFilter = parseDateFilter(normalized, timezone, baseDate);
  const dateOnlyFollowUp =
    hasRecentAsanaContext(history, memoryEntries) &&
    !/\btask\b|\bmy tasks\b/.test(normalized) &&
    Boolean(dateFilter) &&
    isDateOnlyAsanaFollowUp(normalized);
  const wantsTaskList =
    /\btask\b/.test(normalized) ||
    /\bmy tasks\b/.test(normalized) ||
    /\bacross all projects\b/.test(normalized) ||
    /\bacross my tasks\b/.test(normalized) ||
    /\bdue\b/.test(normalized) ||
    dateOnlyFollowUp;

  if (!dateFilter || !wantsTaskList) return null;

  return {
    scope: scope.scope,
    project: scope.project,
    dueOn: dateFilter.dueOn,
    dueBefore: dateFilter.dueBefore,
    completed: false,
    sortBy: "due",
    sortDirection: "asc",
    limit: 50,
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
  if (!isLikelyAsanaRequest(normalized, history, memoryEntries)) return null;
  if (!/\b(last|latest)\b/.test(normalized)) return null;

  const scope = resolveScope(normalized, memoryEntries);
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
    emphasizeImportance?: boolean;
  }
): string {
  if (!tasks.length) return input.emptyLabel;

  const intro = input.emphasizeImportance
    ? `Here are the open Asana tasks I can see ${input.label}${input.scopeName ? ` in ${input.scopeName}` : ""}. I can't reliably rank importance from Asana alone, so I'm listing them with context:`
    : `Here are the open Asana tasks ${input.label}${input.scopeName ? ` in ${input.scopeName}` : ""}:`;

  const body = tasks
    .slice(0, 20)
    .map((task, index) => `${index + 1}. ${formatTaskLine(task)}`)
    .join("\n");

  return `${intro}\n\n${body}`;
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
    (input.completed ? task.completedAt : task.modifiedAt) ??
    task.modifiedAt ??
    task.createdAt;
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
  return text.trim().toLowerCase();
}

function isLikelyAsanaRequest(
  normalizedText: string,
  history: ResponseInputItem[],
  memoryEntries: PromptMemoryEntry[]
): boolean {
  if (/\basana\b/.test(normalizedText)) return true;
  if (/\bmy tasks\b|\btask\b/.test(normalizedText)) return true;
  if (!hasRecentAsanaContext(history, memoryEntries)) return false;
  return (
    /\bbefore yesterday\b/.test(normalizedText) ||
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
  normalizedText: string,
  memoryEntries: PromptMemoryEntry[]
): { scope: "my_tasks" | "project"; project?: ResolvedAsanaProjectShortcut } {
  if (/\bacross all projects\b|\bacross my tasks\b|\ball projects\b/.test(normalizedText)) {
    return { scope: "my_tasks" };
  }

  const project = resolveRecentProjectFromText(normalizedText, memoryEntries);
  if (project) {
    return { scope: "project", project };
  }

  return { scope: "my_tasks" };
}

function parseDateFilter(
  normalizedText: string,
  timezone: string,
  baseDate: Date
): { dueOn?: string; dueBefore?: string; label: string } | null {
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

  if (/\bbefore yesterday\b/.test(normalizedText)) {
    return {
      dueBefore: relativeDateIso(timezone, -2, baseDate),
      label: "due before yesterday"
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

  return null;
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
    .map((value) =>
      value &&
      typeof value === "object" &&
      typeof (value as { projectGid?: unknown }).projectGid === "string"
        ? {
            projectGid: (value as { projectGid: string }).projectGid,
            name:
              typeof (value as { name?: unknown }).name === "string"
                ? (value as { name: string }).name
                : "(Untitled project)"
          }
        : null
    )
    .filter((value): value is ResolvedAsanaProjectShortcut => Boolean(value));
}

function resolveRecentProjectFromText(
  normalizedText: string,
  memoryEntries: PromptMemoryEntry[]
): ResolvedAsanaProjectShortcut | null {
  const candidates = recentAsanaProjects(memoryEntries).filter((project) =>
    new RegExp(`(^|\\b)${escapeRegExp(project.name.toLowerCase())}(\\b|$)`).test(normalizedText)
  );

  if (!candidates.length) return null;
  candidates.sort((left, right) => right.name.length - left.name.length);
  return candidates[0] ?? null;
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
    new Set(tasks.map((task) => task.projectName).filter((value): value is string => Boolean(value)))
  );
  return names.length === 1 ? names[0] : undefined;
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
  return projectName ?? (task.workspaceName && !(task.projects?.length) ? "No project" : undefined);
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
