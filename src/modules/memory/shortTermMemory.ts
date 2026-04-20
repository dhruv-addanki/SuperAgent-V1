import { MessageRole, type PrismaClient } from "@prisma/client";
import { SHORT_TERM_MESSAGE_LIMIT } from "../../config/constants";
import type { ResponseInputItem } from "../../lib/openaiClient";

export class ShortTermMemory {
  constructor(private readonly prisma: PrismaClient) {}

  async loadConversationHistory(
    conversationId: string,
    limit = SHORT_TERM_MESSAGE_LIMIT
  ): Promise<ResponseInputItem[]> {
    const messages = await this.prisma.message.findMany({
      where: {
        conversationId,
        role: { in: [MessageRole.USER, MessageRole.ASSISTANT] }
      },
      orderBy: { createdAt: "desc" },
      take: limit
    });

    return messages.reverse().map((message) => ({
      role: message.role === MessageRole.USER ? "user" : "assistant",
      content: message.content
    }));
  }
}
