import { fromZonedTime, toZonedTime } from "date-fns-tz";

export interface AsanaCalendarCreateShortcut {
  title: string;
  dueOn?: string;
  calendar: {
    title: string;
    start: string;
    end: string;
  };
}

interface DateTarget {
  offsetDays: number;
  explicit: boolean;
}

interface ParsedTimeRange {
  startHour: number;
  startMinute: number;
  endHour?: number;
  endMinute?: number;
}

export function matchAsanaCalendarCreateRequest(
  text: string,
  timezone: string,
  baseDate = new Date()
): AsanaCalendarCreateShortcut | null {
  const normalized = normalize(text);
  if (!/\b(?:add|create|make|put|schedule|book)\b/.test(normalized)) return null;
  if (!/\basana\b/.test(normalized) || !/\b(?:cal|calendar)\b/.test(normalized)) return null;
  if (!/\b(?:asana\s+)?tasks?\b/.test(normalized)) return null;

  const title = extractCompoundCreateTitle(text);
  if (!title) return null;

  const parsedTime = parseTimeRange(text);
  if (!parsedTime) return null;

  let calendarDate = parseCalendarDateTarget(text) ?? parseDueDateTarget(text) ?? {
    offsetDays: 0,
    explicit: false
  };
  let range = buildIsoRange(calendarDate.offsetDays, parsedTime, timezone, baseDate);
  if (!calendarDate.explicit && new Date(range.start).getTime() <= baseDate.getTime()) {
    calendarDate = { offsetDays: calendarDate.offsetDays + 1, explicit: false };
    range = buildIsoRange(calendarDate.offsetDays, parsedTime, timezone, baseDate);
  }

  const dueDate = parseDueDateTarget(text);
  return {
    title,
    ...(dueDate ? { dueOn: localDateForOffset(dueDate.offsetDays, timezone, baseDate) } : {}),
    calendar: {
      title,
      start: range.start,
      end: range.end
    }
  };
}

function extractCompoundCreateTitle(text: string): string | null {
  const actionMatch = text.match(/\b(?:add|create|make|put|schedule|book)\s+(.+)$/i);
  if (!actionMatch?.[1]) return null;
  const source = actionMatch[1].trim();
  const boundaries = [
    /\s+(?:as|to)\s+(?:an?\s+)?(?:asana\s+)?tasks?\b/i,
    /\s+due\s+/i,
    /\s+and\s+(?:also\s+)?(?:add|put|schedule|book)\s+(?:it|this|that)?\s*(?:to|on|in)\s+(?:my\s+)?(?:cal|calendar)\b/i,
    /\s+(?:to|on|in)\s+(?:my\s+)?(?:cal|calendar)\b/i
  ];
  const boundaryIndex = boundaries.reduce((best, pattern) => {
    const match = pattern.exec(source);
    if (!match) return best;
    return Math.min(best, match.index);
  }, source.length);

  const title = cleanupTitle(source.slice(0, boundaryIndex));
  return title && !/^(?:it|this|that)$/i.test(title) ? title : null;
}

function cleanupTitle(value: string): string {
  return value
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTimeRange(text: string): ParsedTimeRange | null {
  const match = text.match(
    /\b(?:at|from)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:(?:-|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i
  );
  if (!match?.[1]) return null;

  const startPeriod = normalizePeriod(match[3] ?? match[6]);
  const endPeriod = normalizePeriod(match[6] ?? match[3]);
  const startHour = normalizeHour(Number(match[1]), startPeriod);
  const startMinute = match[2] ? Number(match[2]) : 0;
  if (!validTime(startHour, startMinute)) return null;

  if (!match[4]) {
    return { startHour, startMinute };
  }

  let endHour = normalizeHour(Number(match[4]), endPeriod);
  const endMinute = match[5] ? Number(match[5]) : 0;
  if (!validTime(endHour, endMinute)) return null;
  if (endHour < startHour || (endHour === startHour && endMinute <= startMinute)) {
    endHour += 12;
  }

  return {
    startHour,
    startMinute,
    endHour,
    endMinute
  };
}

function normalizePeriod(value: string | undefined): "am" | "pm" | undefined {
  const normalized = value?.toLowerCase();
  return normalized === "am" || normalized === "pm" ? normalized : undefined;
}

function normalizeHour(hour: number, period: "am" | "pm" | undefined): number {
  if (!Number.isInteger(hour) || hour < 1 || hour > 12) return Number.NaN;
  if (period === "am") return hour === 12 ? 0 : hour;
  if (period === "pm") return hour === 12 ? 12 : hour + 12;
  if (hour >= 1 && hour <= 7) return hour + 12;
  return hour;
}

function validTime(hour: number, minute: number): boolean {
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function parseCalendarDateTarget(text: string): DateTarget | null {
  const normalized = normalize(text);
  const calendarWindow =
    normalized.match(/\b(?:cal|calendar|event)\b[^.?!]*(today|tomorrow|tmr|tmrw)\b/) ??
    normalized.match(/\b(today|tomorrow|tmr|tmrw)\b[^.?!]*\b(?:cal|calendar|event)\b/);
  return calendarWindow?.[1] ? dateTargetFromWord(calendarWindow[1], true) : null;
}

function parseDueDateTarget(text: string): DateTarget | null {
  const match = normalize(text).match(/\bdue\s+(today|tomorrow|tmr|tmrw)\b/);
  return match?.[1] ? dateTargetFromWord(match[1], true) : null;
}

function dateTargetFromWord(value: string, explicit: boolean): DateTarget {
  return /tomorrow|tmr|tmrw/.test(value)
    ? { offsetDays: 1, explicit }
    : { offsetDays: 0, explicit };
}

function buildIsoRange(
  offsetDays: number,
  parsed: ParsedTimeRange,
  timezone: string,
  baseDate: Date
): { start: string; end: string } {
  const local = localDateObject(offsetDays, timezone, baseDate);
  const startLocal = new Date(
    local.year,
    local.month,
    local.day,
    parsed.startHour,
    parsed.startMinute,
    0,
    0
  );
  const endLocal =
    parsed.endHour === undefined
      ? new Date(startLocal.getTime() + 30 * 60 * 1000)
      : new Date(local.year, local.month, local.day, parsed.endHour, parsed.endMinute ?? 0, 0, 0);
  return {
    start: fromZonedTime(startLocal, timezone).toISOString(),
    end: fromZonedTime(endLocal, timezone).toISOString()
  };
}

function localDateForOffset(offsetDays: number, timezone: string, baseDate: Date): string {
  const local = localDateObject(offsetDays, timezone, baseDate);
  return `${local.year}-${String(local.month + 1).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
}

function localDateObject(
  offsetDays: number,
  timezone: string,
  baseDate: Date
): { year: number; month: number; day: number } {
  const zoned = toZonedTime(baseDate, timezone);
  const local = new Date(zoned.getFullYear(), zoned.getMonth(), zoned.getDate() + offsetDays);
  return {
    year: local.getFullYear(),
    month: local.getMonth(),
    day: local.getDate()
  };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
}
