import type { PrismaClient } from "@prisma/client";

export class LongTermMemory {
  constructor(private readonly prisma: PrismaClient) {}

  async getRelevantMemoryForPrompt(userId: string): Promise<string> {
    const entries = await this.prisma.memoryEntry.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 10
    });

    if (!entries.length) return "No stored user preferences yet.";

    return entries
      .map(
        (entry) =>
          `${entry.key}: ${JSON.stringify(entry.value)}${entry.confidence ? ` (${entry.confidence})` : ""}`
      )
      .join("\n");
  }

  async maybeExtractMemoryFromConversation(userId: string, text: string): Promise<void> {
    const timezoneMatch = text.match(/\bmy timezone is ([A-Za-z_/]+)\b/i);
    if (timezoneMatch?.[1]) {
      await this.prisma.memoryEntry.upsert({
        where: { userId_key: { userId, key: "preferred_timezone" } },
        update: {
          value: { timezone: timezoneMatch[1] },
          confidence: 0.9
        },
        create: {
          userId,
          key: "preferred_timezone",
          value: { timezone: timezoneMatch[1] },
          confidence: 0.9
        }
      });
    }

    const toneMatch = text.match(
      /\b(prefer|use) (a )?(concise|friendly|formal|direct) email tone\b/i
    );
    if (toneMatch?.[3]) {
      await this.prisma.memoryEntry.upsert({
        where: { userId_key: { userId, key: "preferred_email_tone" } },
        update: {
          value: { tone: toneMatch[3].toLowerCase() },
          confidence: 0.75
        },
        create: {
          userId,
          key: "preferred_email_tone",
          value: { tone: toneMatch[3].toLowerCase() },
          confidence: 0.75
        }
      });
    }
  }
}
