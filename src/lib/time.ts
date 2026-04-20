import { addMinutes } from "date-fns";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { env } from "../config/env";
import { DEFAULT_TIMEZONE } from "../config/constants";

export function now(): Date {
  return new Date();
}

export function pendingActionExpiry(from: Date = now()): Date {
  return addMinutes(from, env.PENDING_ACTION_TTL_MINUTES);
}

export function formatForUser(date: Date | string, timezone = DEFAULT_TIMEZONE): string {
  return formatInTimeZone(date, timezone, "EEE, MMM d, yyyy h:mm a zzz");
}

export function startOfTomorrowIso(timezone = DEFAULT_TIMEZONE, baseDate = now()): string {
  const zoned = toZonedTime(baseDate, timezone);
  const tomorrow = new Date(zoned);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow.toISOString();
}
