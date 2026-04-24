import { Channel, MessageRole, type Conversation, type PrismaClient } from "@prisma/client";

export async function getOrCreateWhatsAppConversation(
  prisma: PrismaClient,
  userId: string
): Promise<Conversation> {
  const existing = await prisma.conversation.findFirst({
    where: {
      userId,
      channel: Channel.WHATSAPP
    },
    orderBy: { updatedAt: "desc" }
  });

  if (existing) return existing;

  return prisma.conversation.create({
    data: {
      userId,
      channel: Channel.WHATSAPP
    }
  });
}

export async function persistMessage(
  prisma: PrismaClient,
  input: {
    conversationId: string;
    role: MessageRole;
    senderPhone?: string | null;
    content: string;
    rawPayload?: unknown;
  }
) {
  return prisma.message.create({
    data: {
      conversationId: input.conversationId,
      role: input.role,
      senderPhone: input.senderPhone ?? null,
      content: input.content,
      rawPayload: input.rawPayload === undefined ? undefined : (input.rawPayload as any)
    }
  });
}
