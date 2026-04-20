import type { PrismaClient } from "@prisma/client";
import { serializeError } from "../../lib/errors";

export interface AuditInput {
  userId?: string | null;
  actionType: string;
  toolName: string;
  requestPayload: unknown;
  responsePayload?: unknown;
  status: "pending" | "success" | "failed" | "executed" | "blocked";
  error?: unknown;
}

export class AuditService {
  constructor(private readonly prisma: PrismaClient) {}

  async log(input: AuditInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        userId: input.userId ?? null,
        actionType: input.actionType,
        toolName: input.toolName,
        requestPayload: input.requestPayload as any,
        responsePayload:
          input.responsePayload === undefined ? undefined : (input.responsePayload as any),
        status: input.status,
        errorMessage: input.error ? serializeError(input.error) : null
      }
    });
  }
}
