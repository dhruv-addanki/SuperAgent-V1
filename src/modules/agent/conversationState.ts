import {
  Channel,
  MessageRole,
  MessageSenderType,
  type Conversation,
  type PrismaClient
} from "@prisma/client";

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
    senderType?: MessageSenderType;
    senderPhone?: string | null;
    content: string;
    rawPayload?: unknown;
  }
) {
  return prisma.message.create({
    data: {
      conversationId: input.conversationId,
      role: input.role,
      senderType: input.senderType ?? senderTypeForRole(input.role),
      senderPhone: input.senderPhone ?? null,
      content: input.content,
      rawPayload: input.rawPayload === undefined ? undefined : (input.rawPayload as any)
    }
  });
}

function senderTypeForRole(role: MessageRole): MessageSenderType {
  switch (role) {
    case MessageRole.USER:
      return MessageSenderType.USER;
    case MessageRole.ASSISTANT:
      return MessageSenderType.AGENT;
    case MessageRole.TOOL:
      return MessageSenderType.TOOL;
    case MessageRole.SYSTEM:
      return MessageSenderType.SYSTEM;
  }
}
