import { ExternalApiError } from "../../lib/errors";
import type { CalendarEventSummary } from "./googleTypes";

const { google } = require("googleapis") as any;

export class CalendarService {
  constructor(private readonly auth: any) {}

  async listEvents(timeMin: string, timeMax: string): Promise<CalendarEventSummary[]> {
    try {
      const calendar = google.calendar({ version: "v3", auth: this.auth });
      const result = await calendar.events.list({
        calendarId: "primary",
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 25
      });

      return (result.data.items ?? []).map((event: any) => ({
        id: event.id ?? undefined,
        title: event.summary ?? "(Untitled)",
        start: event.start?.dateTime ?? event.start?.date ?? undefined,
        end: event.end?.dateTime ?? event.end?.date ?? undefined,
        attendees: event.attendees?.map((attendee: any) => attendee.email ?? "").filter(Boolean),
        location: event.location ?? undefined,
        htmlLink: event.htmlLink ?? undefined
      }));
    } catch (error) {
      throw new ExternalApiError("calendar", "I couldn't reach Google Calendar right now.", error);
    }
  }

  async createEvent(input: {
    title: string;
    start: string;
    end: string;
    attendees?: string[];
    location?: string;
    description?: string;
  }): Promise<CalendarEventSummary> {
    try {
      const calendar = google.calendar({ version: "v3", auth: this.auth });
      const result = await calendar.events.insert({
        calendarId: "primary",
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

      return {
        id: result.data.id ?? undefined,
        title: result.data.summary ?? input.title,
        start: result.data.start?.dateTime ?? input.start,
        end: result.data.end?.dateTime ?? input.end,
        attendees: result.data.attendees
          ?.map((attendee: any) => attendee.email ?? "")
          .filter(Boolean),
        location: result.data.location ?? undefined,
        htmlLink: result.data.htmlLink ?? undefined
      };
    } catch (error) {
      throw new ExternalApiError("calendar", "I wasn't able to create that event.", error);
    }
  }
}
