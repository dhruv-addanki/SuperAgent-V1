import { ExternalApiError } from "../../lib/errors";
import type {
  GmailDraftResult,
  GmailSendResult,
  GmailTrashResult,
  GmailThreadMessage,
  GmailThreadSummary
} from "./googleTypes";

const { google } = require("googleapis") as any;

function getHeader(
  headers: Array<{ name?: string | null; value?: string | null }> = [],
  name: string
) {
  return (
    headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined
  );
}

function decodeBase64Url(value?: string | null): string | undefined {
  if (!value) return undefined;
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function plainTextFromPayload(payload: any): string | undefined {
  if (!payload) return undefined;
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts ?? []) {
    const found = plainTextFromPayload(part);
    if (found) return found;
  }
  return undefined;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeMimeHeader(value: string): string {
  const sanitized = sanitizeHeaderValue(value);
  if (!/[^\x20-\x7E]/.test(sanitized)) {
    return sanitized;
  }

  const encoded = Buffer.from(sanitized, "utf8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

export function encodeMimeMessage(to: string, subject: string, body: string): string {
  const message = [
    `To: ${sanitizeHeaderValue(to)}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    "",
    body
  ].join("\r\n");

  return Buffer.from(message, "utf8").toString("base64url");
}

export class GmailService {
  constructor(private readonly auth: any) {}

  async searchThreads(query: string, maxResults = 10): Promise<GmailThreadSummary[]> {
    try {
      const gmail = google.gmail({ version: "v1", auth: this.auth });
      const list = await gmail.users.threads.list({
        userId: "me",
        q: query,
        maxResults
      });

      const threads = list.data.threads ?? [];
      const hydrated = await Promise.all(
        threads.map(async (thread: any) => {
          const details = await gmail.users.threads.get({
            userId: "me",
            id: thread.id ?? "",
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"]
          });
          const message = details.data.messages?.[0];
          const headers = message?.payload?.headers ?? [];
          return {
            threadId: details.data.id ?? thread.id ?? "",
            snippet: details.data.snippet ?? message?.snippet ?? undefined,
            subject: getHeader(headers, "Subject"),
            from: getHeader(headers, "From"),
            date: getHeader(headers, "Date")
          };
        })
      );

      return hydrated.filter((thread) => thread.threadId);
    } catch (error) {
      throw new ExternalApiError("gmail", "I couldn't reach Gmail right now.", error);
    }
  }

  async readThread(threadId: string): Promise<GmailThreadMessage[]> {
    try {
      const gmail = google.gmail({ version: "v1", auth: this.auth });
      const thread = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "full"
      });

      return (thread.data.messages ?? []).map((message: any) => {
        const headers = message.payload?.headers ?? [];
        return {
          id: message.id ?? "",
          threadId: message.threadId ?? threadId,
          from: getHeader(headers, "From"),
          to: getHeader(headers, "To"),
          subject: getHeader(headers, "Subject"),
          date: getHeader(headers, "Date"),
          snippet: message.snippet ?? undefined,
          bodyText: plainTextFromPayload(message.payload)
        };
      });
    } catch (error) {
      throw new ExternalApiError("gmail", "I couldn't reach Gmail right now.", error);
    }
  }

  async createDraft(input: {
    to: string;
    subject: string;
    body: string;
  }): Promise<GmailDraftResult> {
    try {
      const gmail = google.gmail({ version: "v1", auth: this.auth });
      const draft = await gmail.users.drafts.create({
        userId: "me",
        requestBody: {
          message: {
            raw: encodeMimeMessage(input.to, input.subject, input.body)
          }
        }
      });

      return {
        draftId: draft.data.id ?? "",
        messageId: draft.data.message?.id ?? undefined,
        to: input.to,
        subject: input.subject,
        summary: `Draft to ${input.to}: ${input.subject}`
      };
    } catch (error) {
      throw new ExternalApiError("gmail", "I wasn't able to create that email draft.", error);
    }
  }

  async sendDraft(draftId: string): Promise<GmailSendResult> {
    try {
      const gmail = google.gmail({ version: "v1", auth: this.auth });
      const result = await gmail.users.drafts.send({
        userId: "me",
        requestBody: { id: draftId }
      });

      return {
        draftId,
        messageId: result.data.id ?? undefined,
        threadId: result.data.threadId ?? undefined
      };
    } catch (error) {
      throw new ExternalApiError("gmail", "I wasn't able to send that email.", error);
    }
  }

  async trashThread(threadId: string): Promise<GmailTrashResult> {
    try {
      const gmail = google.gmail({ version: "v1", auth: this.auth });
      await gmail.users.threads.trash({
        userId: "me",
        id: threadId
      });

      return {
        threadId,
        summary: "Moved the email thread to Trash."
      };
    } catch (error) {
      throw new ExternalApiError("gmail", "I wasn't able to delete that email.", error);
    }
  }
}
