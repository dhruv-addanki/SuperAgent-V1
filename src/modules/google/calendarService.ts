import { ExternalApiError } from "../../lib/errors";
import type {
  CalendarEventSummary,
  CalendarSummary,
  DeletedCalendarEventResult
} from "./googleTypes";

const { google } = require("googleapis") as any;

function normalizeEvent(
  event: any,
  calendarId: string,
  calendarSummary?: string
): CalendarEventSummary {
  return {
    id: event.id ?? undefined,
    title: event.summary ?? "(Untitled)",
    start: event.start?.dateTime ?? event.start?.date ?? undefined,
    end: event.end?.dateTime ?? event.end?.date ?? undefined,
    attendees: event.attendees?.map((attendee: any) => attendee.email ?? "").filter(Boolean),
    location: event.location ?? undefined,
    htmlLink: event.htmlLink ?? undefined,
    calendarId,
    calendarSummary
  };
}

function eventStartTime(value?: string): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp;
}

export function mergeCalendarEventCollections(
  collections: CalendarEventSummary[][],
  maxResults: number
): CalendarEventSummary[] {
  return collections
    .flat()
    .sort((left, right) => eventStartTime(left.start) - eventStartTime(right.start))
    .slice(0, maxResults);
}

export class CalendarService {
  constructor(private readonly auth: any) {}

  private async fetchReadableCalendars(calendar: any): Promise<Array<{ id: string; summary: string }>> {
    const result = await calendar.calendarList.list({
      fields: "items(id,summary,primary,accessRole)",
      minAccessRole: "reader",
      showHidden: false
    });

    return (result.data.items ?? [])
      .map((entry: any) => ({
        id: entry.id ?? "",
        summary: entry.summary ?? "(Untitled calendar)"
      }))
      .filter((entry: { id: string }) => Boolean(entry.id));
  }

  async listCalendars(): Promise<CalendarSummary[]> {
    try {
      const calendar = google.calendar({ version: "v3", auth: this.auth });
      const result = await calendar.calendarList.list({
        fields: "items(id,summary,primary,accessRole)",
        minAccessRole: "reader",
        showHidden: false
      });

      return (result.data.items ?? []).map((entry: any) => ({
        id: entry.id ?? "",
        summary: entry.summary ?? "(Untitled calendar)",
        primary: entry.primary ?? false,
        accessRole: entry.accessRole ?? undefined
      }));
    } catch (error) {
      throw new ExternalApiError(
        "calendar",
        "Reconnect your Google account to access all calendars, or try again later.",
        error
      );
    }
  }

  async listEvents(input: {
    timeMin: string;
    timeMax: string;
    calendarId?: string;
    query?: string;
    maxResults?: number;
  }): Promise<CalendarEventSummary[]> {
    try {
      const calendar = google.calendar({ version: "v3", auth: this.auth });
      if (input.calendarId) {
        const calendarId = input.calendarId;
        const result = await calendar.events.list({
          calendarId,
          timeMin: input.timeMin,
          timeMax: input.timeMax,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: input.maxResults ?? 25,
          q: input.query
        });

        return (result.data.items ?? []).map((event: any) => normalizeEvent(event, calendarId));
      }

      const calendars = await this.fetchReadableCalendars(calendar);
      const perCalendarResults = await Promise.all(
        calendars.map(async (entry) => {
          const result = await calendar.events.list({
            calendarId: entry.id,
            timeMin: input.timeMin,
            timeMax: input.timeMax,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: input.maxResults ?? 25,
            q: input.query
          });

          return (result.data.items ?? []).map((event: any) =>
            normalizeEvent(event, entry.id, entry.summary)
          );
        })
      );

      return mergeCalendarEventCollections(perCalendarResults, input.maxResults ?? 25);
    } catch (error) {
      throw new ExternalApiError("calendar", "I couldn't reach Google Calendar right now.", error);
    }
  }

  async createEvent(input: {
    calendarId?: string;
    title: string;
    start: string;
    end: string;
    attendees?: string[];
    location?: string;
    description?: string;
  }): Promise<CalendarEventSummary> {
    try {
      const calendar = google.calendar({ version: "v3", auth: this.auth });
      const calendarId = input.calendarId ?? "primary";
      const result = await calendar.events.insert({
        calendarId,
        sendUpdates: input.attendees?.length ? "all" : "none",
        requestBody: {
          summary: input.title,
          start: { dateTime: input.start },
          end: { dateTime: input.end },
          attendees: input.attendees?.map((email) => ({ email })),
          location: input.location,
          description: input.description
        }
      });

      return normalizeEvent(result.data, calendarId);
    } catch (error) {
      throw new ExternalApiError("calendar", "I wasn't able to create that event.", error);
    }
  }

  async updateEvent(input: {
    eventId: string;
    calendarId?: string;
    targetCalendarId?: string;
    title?: string;
    start?: string;
    end?: string;
    attendees?: string[];
    location?: string;
    description?: string;
  }): Promise<CalendarEventSummary> {
    try {
      const calendar = google.calendar({ version: "v3", auth: this.auth });
      let calendarId = input.calendarId ?? "primary";
      let eventId = input.eventId;
      let movedEvent: any | undefined;

      if (input.targetCalendarId && input.targetCalendarId !== calendarId) {
        const moved = await calendar.events.move({
          calendarId,
          eventId,
          destination: input.targetCalendarId
        });
        movedEvent = moved.data;
        calendarId = input.targetCalendarId;
        eventId = moved.data.id ?? eventId;
      }

      const requestBody: Record<string, unknown> = {};
      if (input.title !== undefined) requestBody.summary = input.title;
      if (input.start !== undefined) requestBody.start = { dateTime: input.start };
      if (input.end !== undefined) requestBody.end = { dateTime: input.end };
      if (input.attendees !== undefined) {
        requestBody.attendees = input.attendees.map((email) => ({ email }));
      }
      if (input.location !== undefined) requestBody.location = input.location;
      if (input.description !== undefined) requestBody.description = input.description;

      if (!Object.keys(requestBody).length) {
        return normalizeEvent(movedEvent ?? { id: eventId, summary: "(Updated event)" }, calendarId);
      }

      const result = await calendar.events.patch({
        calendarId,
        eventId,
        sendUpdates: input.attendees?.length ? "all" : "none",
        requestBody
      });

      return normalizeEvent(result.data, calendarId);
    } catch (error) {
      throw new ExternalApiError("calendar", "I wasn't able to update that event.", error);
    }
  }

  async deleteEvent(input: {
    eventId: string;
    calendarId?: string;
  }): Promise<DeletedCalendarEventResult> {
    try {
      const calendar = google.calendar({ version: "v3", auth: this.auth });
      const calendarId = input.calendarId ?? "primary";
      const event = await calendar.events.get({
        calendarId,
        eventId: input.eventId
      });

      await calendar.events.delete({
        calendarId,
        eventId: input.eventId,
        sendUpdates: "none"
      });

      return {
        eventId: input.eventId,
        calendarId,
        title: event.data.summary ?? undefined,
        summary: `Deleted: ${event.data.summary ?? "event"}`
      };
    } catch (error) {
      throw new ExternalApiError("calendar", "I wasn't able to delete that event.", error);
    }
  }
}
