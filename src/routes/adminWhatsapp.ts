import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { PrismaClient } from "@prisma/client";
import { env } from "../config/env";
import { UserFacingError } from "../lib/errors";
import type { ResponsesClient } from "../lib/openaiClient";
import {
  AdminWhatsAppOutboundService,
  type AdminOutboundResult
} from "../modules/admin/adminWhatsappOutboundService";
import { WhatsAppService } from "../modules/whatsapp/whatsappService";

const outboundSchema = z.object({
  phone: z.string().min(5),
  mode: z.enum(["exact", "draft", "auto"]).optional().default("auto"),
  message: z.string().min(1).optional(),
  instruction: z.string().min(1).optional(),
  request: z.string().min(1).optional()
});

const confirmationSchema = z.object({
  approvalCode: z.string().min(1)
});

export interface AdminWhatsAppRouteDeps {
  prisma?: PrismaClient;
  responsesClient?: ResponsesClient;
  whatsappService?: WhatsAppService;
  service?: AdminWhatsAppOutboundService;
}

export async function registerAdminWhatsAppRoutes(
  app: FastifyInstance,
  deps: AdminWhatsAppRouteDeps
): Promise<void> {
  const service =
    deps.service ??
    new AdminWhatsAppOutboundService(
      requiredDep(deps.prisma, "prisma"),
      requiredDep(deps.responsesClient, "responsesClient"),
      deps.whatsappService ?? new WhatsAppService()
    );

  app.post(
    "/admin/whatsapp/outbound",
    { preHandler: verifyAdminRequest },
    async (request, reply) => {
      try {
        const result = await service.submit(outboundSchema.parse(request.body));
        return sendOutboundResult(reply, result);
      } catch (error) {
        return sendAdminError(reply, error);
      }
    }
  );

  app.post(
    "/admin/whatsapp/outbound/confirm",
    { preHandler: verifyAdminRequest },
    async (request, reply) => {
      try {
        const result = await service.confirm(confirmationSchema.parse(request.body));
        return sendOutboundResult(reply, result);
      } catch (error) {
        return sendAdminError(reply, error);
      }
    }
  );

  app.post(
    "/admin/whatsapp/outbound/cancel",
    { preHandler: verifyAdminRequest },
    async (request, reply) => {
      try {
        return reply.send(await service.cancel(confirmationSchema.parse(request.body)));
      } catch (error) {
        return sendAdminError(reply, error);
      }
    }
  );
}

function verifyAdminRequest(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const header = request.headers.authorization;
  const expected = `Bearer ${env.ADMIN_API_TOKEN}`;
  if (typeof header === "string" && timingSafeEqual(header, expected)) {
    done();
    return;
  }

  reply.code(401).send({
    error: "Unauthorized",
    message: "Missing or invalid admin API token."
  });
}

function timingSafeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function sendOutboundResult(reply: FastifyReply, result: AdminOutboundResult) {
  return reply.code(result.status === "pending" ? 202 : 200).send(result);
}

function sendAdminError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: "Bad Request",
      message: error.issues[0]?.message ?? "Invalid request body."
    });
  }

  if (error instanceof UserFacingError) {
    return reply.code(statusForCode(error.code)).send({
      error: error.code,
      message: error.userMessage
    });
  }

  throw error;
}

function statusForCode(code: string): number {
  if (code === "ADMIN_OUTBOUND_NOT_FOUND") return 404;
  if (code === "ADMIN_OUTBOUND_EXPIRED") return 410;
  if (code === "ADMIN_OUTBOUND_NOT_PENDING" || code === "ADMIN_OUTBOUND_WRONG_ACTION") return 409;
  return 400;
}

function requiredDep<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`Missing ${name} for admin WhatsApp routes`);
  return value;
}
