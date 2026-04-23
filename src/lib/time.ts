import { addMinutes } from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
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
  const localTomorrowMidnight = new Date(
    zoned.getFullYear(),
    zoned.getMonth(),
    zoned.getDate() + 1,
    0,
    0,
    0,
    0
  );
  return fromZonedTime(localTomorrowMidnight, timezone).toISOString();
}
