export interface GmailThreadSummary {
  threadId: string;
  snippet?: string;
  subject?: string;
  from?: string;
  date?: string;
}

export interface GmailThreadMessage {
  id: string;
  threadId: string;
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  bodyText?: string;
}

export interface GmailDraftResult {
  draftId: string;
  messageId?: string;
  to: string;
  subject: string;
  summary: string;
}

export interface GmailSendResult {
  draftId: string;
  messageId?: string;
  threadId?: string;
}

export interface CalendarEventSummary {
  id?: string;
  title: string;
  start?: string;
  end?: string;
  attendees?: string[];
  location?: string;
  htmlLink?: string;
  calendarId?: string;
  calendarSummary?: string;
}

export interface CalendarSummary {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole?: string;
}

export interface DeletedCalendarEventResult {
  eventId: string;
  calendarId: string;
  title?: string;
  summary: string;
}

export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
  owners?: string[];
}

export interface CreatedDocResult {
  documentId: string;
  title: string;
  url: string;
  summary: string;
}
