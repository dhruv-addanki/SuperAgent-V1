import { ExternalApiError } from "../../lib/errors";
import type { CreatedDocResult, ReadDocResult, UpdatedDocResult } from "./googleTypes";

const { google } = require("googleapis") as any;
const DOC_TEXT_LIMIT = 12_000;

export function extractDocumentText(content: any[] = []): string {
  const chunks: string[] = [];

  for (const element of content) {
    if (element.paragraph?.elements) {
      const paragraphText = element.paragraph.elements
        .map((paragraphElement: any) => paragraphElement.textRun?.content ?? "")
        .join("");
      if (paragraphText.trim()) {
        chunks.push(paragraphText.trimEnd());
      }
    }

    if (element.table?.tableRows) {
      for (const row of element.table.tableRows) {
        for (const cell of row.tableCells ?? []) {
          const cellText = extractDocumentText(cell.content ?? []);
          if (cellText.trim()) chunks.push(cellText);
        }
      }
    }

    if (element.tableOfContents?.content) {
      const tocText = extractDocumentText(element.tableOfContents.content);
      if (tocText.trim()) chunks.push(tocText);
    }
  }

  return chunks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export class DocsService {
  constructor(private readonly auth: any) {}

  async readDocument(documentId: string): Promise<ReadDocResult> {
    try {
      const docs = google.docs({ version: "v1", auth: this.auth });
      const document = await docs.documents.get({ documentId });
      const title = document.data.title ?? "(Untitled document)";
      const fullText = extractDocumentText(document.data.body?.content ?? []);
      const truncated = fullText.length > DOC_TEXT_LIMIT;
      const text = truncated ? `${fullText.slice(0, DOC_TEXT_LIMIT).trimEnd()}\n…` : fullText;

      return {
        documentId,
        title,
        url: `https://docs.google.com/document/d/${documentId}/edit`,
        text,
        truncated,
        summary: `Loaded Google Doc: ${title}`
      };
    } catch (error) {
      throw new ExternalApiError("docs", "I wasn't able to read that Google Doc.", error);
    }
  }

  async appendToDocument(input: {
    documentId: string;
    content: string;
  }): Promise<UpdatedDocResult> {
    try {
      const docs = google.docs({ version: "v1", auth: this.auth });
      const document = await docs.documents.get({ documentId: input.documentId });
      const title = document.data.title ?? "(Untitled document)";
      const bodyContent = document.data.body?.content ?? [];
      const endIndex = bodyContent.at(-1)?.endIndex ?? 1;
      const existingText = extractDocumentText(bodyContent);
      const prefix = existingText.trim() ? "\n\n" : "";

      await docs.documents.batchUpdate({
        documentId: input.documentId,
        requestBody: {
          requests: [
            {
              insertText: {
                location: { index: Math.max(1, endIndex - 1) },
                text: `${prefix}${input.content}`
              }
            }
          ]
        }
      });

      return {
        documentId: input.documentId,
        title,
        url: `https://docs.google.com/document/d/${input.documentId}/edit`,
        summary: `Updated Google Doc: ${title}`
      };
    } catch (error) {
      throw new ExternalApiError("docs", "I wasn't able to update that Google Doc.", error);
    }
  }

  async createDocument(input: {
    title: string;
    content: string;
    folderId?: string;
  }): Promise<CreatedDocResult> {
    try {
      const docs = google.docs({ version: "v1", auth: this.auth });
      const created = await docs.documents.create({
        requestBody: {
          title: input.title
        }
      });

      const documentId = created.data.documentId;
      if (!documentId) {
        throw new Error("Google Docs did not return a document ID");
      }

      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text: input.content
              }
            }
          ]
        }
      });

      if (input.folderId) {
        const drive = google.drive({ version: "v3", auth: this.auth });
        await drive.files.update({
          fileId: documentId,
          addParents: input.folderId,
          fields: "id, parents",
          supportsAllDrives: true
        });
      }

      return {
        documentId,
        title: input.title,
        url: `https://docs.google.com/document/d/${documentId}/edit`,
        summary: `Created Google Doc: ${input.title}`
      };
    } catch (error) {
      throw new ExternalApiError("docs", "I wasn't able to create that document.", error);
    }
  }
}
