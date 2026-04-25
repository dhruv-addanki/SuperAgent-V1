import { format } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { z } from "zod";
import { DEFAULT_TIMEZONE } from "../../config/constants";

export const automationScheduleSchema = z
  .object({
    frequency: z.enum(["daily", "weekdays", "weekly"]),
    time: z.string().regex(/^\d{2}:\d{2}$/),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const [hours, minutes] = value.time.split(":").map(Number);
    if (hours === undefined || minutes === undefined || hours > 23 || minutes > 59) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["time"],
        message: "time must be a valid HH:mm local time"
      });
    }

    if (value.frequency === "weekly" && !value.daysOfWeek?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["daysOfWeek"],
        message: "weekly schedules require at least one day"
      });
    }
  });

export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function normalizeAutomationSchedule(value: unknown): AutomationSchedule {
  const schedule = automationScheduleSchema.parse(value);
  if (schedule.frequency !== "weekly") {
    return {
      frequency: schedule.frequency,
      time: schedule.time
    };
  }

  return {
    frequency: "weekly",
    time: schedule.time,
    daysOfWeek: uniqueSortedDays(schedule.daysOfWeek ?? [])
  };
}

export function computeNextRunAt(
  scheduleInput: unknown,
  timezone = DEFAULT_TIMEZONE,
  from = new Date()
): Date {
  const schedule = normalizeAutomationSchedule(scheduleInput);
  const [hours, minutes] = schedule.time.split(":").map(Number) as [number, number];
  const localNow = toZonedTime(from, timezone);
  const allowedDays = daysForSchedule(schedule);

  for (let offset = 0; offset <= 14; offset += 1) {
    const localCandidate = new Date(
      localNow.getFullYear(),
      localNow.getMonth(),
      localNow.getDate() + offset,
      hours,
      minutes,
      0,
      0
    );
    if (!allowedDays.includes(localCandidate.getDay())) continue;

    const candidate = fromZonedTime(localCandidate, timezone);
    if (candidate.getTime() > from.getTime() + 500) return candidate;
  }

  throw new Error("Unable to compute next automation run time");
}

export function formatScheduleLabel(
  scheduleInput: unknown,
  timezone = DEFAULT_TIMEZONE
): string {
  const schedule = normalizeAutomationSchedule(scheduleInput);
  const timeLabel = formatLocalTimeLabel(schedule.time);

  if (schedule.frequency === "daily") {
    return `Every day at ${timeLabel} ${timezone}`;
  }

  if (schedule.frequency === "weekdays") {
    return `Weekdays at ${timeLabel} ${timezone}`;
  }

  const days = uniqueSortedDays(schedule.daysOfWeek ?? [])
    .map((day) => DAY_LABELS[day])
    .join(", ");
  return `${days} at ${timeLabel} ${timezone}`;
}

export function formatAutomationName(value: string | null | undefined): string {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized || "Scheduled automation";
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function daysForSchedule(schedule: AutomationSchedule): number[] {
  if (schedule.frequency === "daily") return [0, 1, 2, 3, 4, 5, 6];
  if (schedule.frequency === "weekdays") return [1, 2, 3, 4, 5];
  return uniqueSortedDays(schedule.daysOfWeek ?? []);
}

function uniqueSortedDays(days: number[]): number[] {
  return Array.from(new Set(days)).sort((a, b) => a - b);
}

function formatLocalTimeLabel(time: string): string {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return format(new Date(2000, 0, 1, hours, minutes), "h:mm a");
}
