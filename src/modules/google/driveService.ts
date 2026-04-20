import { ExternalApiError } from "../../lib/errors";
import type { DriveFileSummary } from "./googleTypes";

const { google } = require("googleapis") as any;

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function normalizeFile(file: any): DriveFileSummary {
  return {
    id: file.id ?? "",
    name: file.name ?? "(Untitled)",
    mimeType: file.mimeType ?? undefined,
    modifiedTime: file.modifiedTime ?? undefined,
    webViewLink: file.webViewLink ?? undefined,
    owners: file.owners
      ?.map((owner: any) => owner.emailAddress ?? owner.displayName)
      .filter(Boolean)
  };
}

export class DriveService {
  constructor(private readonly auth: any) {}

  async searchFiles(input: {
    query: string;
    mimeType?: string;
    modifiedAfter?: string;
  }): Promise<DriveFileSummary[]> {
    try {
      const drive = google.drive({ version: "v3", auth: this.auth });
      const escaped = escapeDriveQuery(input.query);
      const clauses = [
        "trashed = false",
        `(name contains '${escaped}' or fullText contains '${escaped}')`
      ];

      if (input.mimeType) clauses.push(`mimeType = '${escapeDriveQuery(input.mimeType)}'`);
      if (input.modifiedAfter) clauses.push(`modifiedTime > '${input.modifiedAfter}'`);

      const result = await drive.files.list({
        q: clauses.join(" and "),
        pageSize: 10,
        orderBy: "modifiedTime desc",
        fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress,displayName))",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      return (result.data.files ?? [])
        .map(normalizeFile)
        .filter((file: DriveFileSummary) => file.id);
    } catch (error) {
      throw new ExternalApiError("drive", "I couldn't reach Google Drive right now.", error);
    }
  }

  async readFileMetadata(fileId: string): Promise<DriveFileSummary> {
    try {
      const drive = google.drive({ version: "v3", auth: this.auth });
      const result = await drive.files.get({
        fileId,
        fields: "id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress,displayName)",
        supportsAllDrives: true
      });

      return normalizeFile(result.data);
    } catch (error) {
      throw new ExternalApiError("drive", "I couldn't reach Google Drive right now.", error);
    }
  }
}
