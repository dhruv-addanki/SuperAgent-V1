import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import type { CalendarEventSummary } from "../google/googleTypes";
import type { ResponseInputItem } from "../../lib/openaiClient";

export type GenericCalendarOverviewTarget = "today" | "tomorrow";

export function matchGenericCalendarOverviewRequest(
  text: string
): GenericCalendarOverviewTarget | null {
  const normalized = text.trim().toLowerCase();
  const referencesGenericCalendar =
    /\bmy calendar\b/.test(normalized) ||
    /\bmy cal\b/.test(normalized) ||
    /\ball my calendars\b/.test(normalized) ||
    /\ball calendars\b/.test(normalized);
  const asksForOverview =
    /\bwhat(?:'s|s)? on\b/.test(normalized) ||
    /\bwhat do i have\b/.test(normalized) ||
    /\bcheck\b/.test(normalized) ||
    /\bshow\b/.test(normalized) ||
    /\bagenda\b/.test(normalized);

  if (!referencesGenericCalendar || !asksForOverview) return null;
  if (/\btomorrow\b/.test(normalized)) return "tomorrow";
  if (/\btoday\b/.test(normalized)) return "today";
  return "today";
}

export function matchCalendarAllCalendarsFollowUpRequest(
  text: string,
  history: ResponseInputItem[]
): GenericCalendarOverviewTarget | null {
  const normalized = text.trim().toLowerCase();
  const affirmative =
    /^(yes|yep|yeah|sure|ok|okay|do it|go ahead)\b/.test(normalized) ||
    /\bcheck (them|it) all\b/.test(normalized) ||
    /\ball calendars\b/.test(normalized);

  if (!affirmative) return null;

  const previousAssistant = lastAssistantMessage(history);
  if (!previousAssistant) return null;
  if (!/all calendars/.test(previousAssistant)) return null;
  if (/tomorrow/.test(previousAssistant)) return "tomorrow";
  return "today";
}

export function calendarOverviewWindow(
  target: GenericCalendarOverviewTarget,
  timezone: string,
  baseDate = new Date()
): { timeMin: string; timeMax: string; label: GenericCalendarOverviewTarget } {
  const offsetDays = target === "tomorrow" ? 1 : 0;
  const timeMin = startOfDayOffsetIso(timezone, offsetDays, baseDate);
  const timeMax = startOfDayOffsetIso(timezone, offsetDays + 1, baseDate);
  return { timeMin, timeMax, label: target };
}

export function formatCalendarOverview(
  events: CalendarEventSummary[],
  timezone: string,
  label: GenericCalendarOverviewTarget
): string {
  if (!events.length) {
    return `Across all calendars ${label}, you're clear.`;
  }

  const body = events
    .map((event) => `• ${formatEventLine(event, timezone)}`)
    .join("\n");

  return `Across all calendars ${label}:\n${body}`;
}

function startOfDayOffsetIso(timezone: string, offsetDays: number, baseDate: Date): string {
  const zoned = toZonedTime(baseDate, timezone);
  const localMidnight = new Date(
    zoned.getFullYear(),
    zoned.getMonth(),
    zoned.getDate() + offsetDays,
    0,
    0,
    0,
    0
  );
  return fromZonedTime(localMidnight, timezone).toISOString();
}

function formatEventLine(event: CalendarEventSummary, timezone: string): string {
  const timeRange = formatTimeRange(event, timezone);
  const calendarSuffix = event.calendarSummary ? ` (${event.calendarSummary})` : "";
  return `${timeRange} — ${event.title}${calendarSuffix}`;
}

function formatTimeRange(event: CalendarEventSummary, timezone: string): string {
  if (!event.start) return "Time TBD";
  if (isAllDay(event.start)) return "All day";
  if (!event.end || isAllDay(event.end)) {
    return formatInTimeZone(event.start, timezone, "h:mm a");
  }

  return `${formatInTimeZone(event.start, timezone, "h:mm a")}-${formatInTimeZone(
    event.end,
    timezone,
    "h:mm a"
  )}`;
}

function isAllDay(value: string): boolean {
  return !value.includes("T");
}

function lastAssistantMessage(history: ResponseInputItem[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.role !== "assistant") continue;
    const content = typeof item.content === "string" ? item.content : null;
    if (content) return content.toLowerCase();
  }

  return null;
}
