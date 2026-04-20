import { ExternalApiError } from "../../lib/errors";
import type { CreatedDocResult } from "./googleTypes";

const { google } = require("googleapis") as any;

export class DocsService {
  constructor(private readonly auth: any) {}

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
