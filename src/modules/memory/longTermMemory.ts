import type { PrismaClient, User } from "@prisma/client";
import type { PromptMemoryEntry } from "../agent/conversationContext";

interface MemoryExtractionResult {
  timezone?: string;
}

interface AssistantResponsePreferences {
  verbosity?: "concise" | "detailed";
  tone?: "direct" | "friendly" | "formal";
  format?: "bullets" | "prose";
  minimalFollowUps?: boolean;
}

export class LongTermMemory {
  constructor(private readonly prisma: PrismaClient) {}

  async getRecentEntriesForContext(userId: string, take = 20): Promise<PromptMemoryEntry[]> {
    const entries = await this.prisma.memoryEntry.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take
    });

    return entries.map((entry) => ({
      key: entry.key,
      value: entry.value,
      confidence: entry.confidence,
      updatedAt: entry.updatedAt instanceof Date ? entry.updatedAt : new Date()
    }));
  }

  async getRelevantMemoryForPrompt(userId: string): Promise<string> {
    const entries = await this.getRecentEntriesForContext(userId, 10);

    if (!entries.length) return "No stored user preferences yet.";

    return entries
      .map(
        (entry) =>
          `${entry.key}: ${JSON.stringify(entry.value)}${entry.confidence ? ` (${entry.confidence})` : ""}`
      )
      .join("\n");
  }

  async maybeExtractMemoryFromConversation(
    user: Pick<User, "id">,
    text: string
  ): Promise<MemoryExtractionResult> {
    const result: MemoryExtractionResult = {};
    const preferredName = extractPreferredName(text);
    if (preferredName) {
      await this.rememberPreferredName(user.id, preferredName);
    }

    const timezone = extractTimezone(text);
    if (timezone && isValidTimezone(timezone)) {
      await this.prisma.memoryEntry.upsert({
        where: { userId_key: { userId: user.id, key: "preferred_timezone" } },
        update: {
          value: { timezone },
          confidence: 0.9
        },
        create: {
          userId: user.id,
          key: "preferred_timezone",
          value: { timezone },
          confidence: 0.9
        }
      });
      await this.prisma.user.update({
        where: { id: user.id },
        data: { timezone }
      });
      result.timezone = timezone;
    }

    const responsePreferences = extractAssistantResponsePreferences(text);
    if (Object.keys(responsePreferences).length) {
      await this.rememberAssistantResponsePreferences(user.id, responsePreferences);
    }

    const toneMatch = text.match(
      /\b(prefer|use) (a )?(concise|friendly|formal|direct) email tone\b/i
    );
    if (toneMatch?.[3]) {
      await this.prisma.memoryEntry.upsert({
        where: { userId_key: { userId: user.id, key: "preferred_email_tone" } },
        update: {
          value: { tone: toneMatch[3].toLowerCase() },
          confidence: 0.75
        },
        create: {
          userId: user.id,
          key: "preferred_email_tone",
          value: { tone: toneMatch[3].toLowerCase() },
          confidence: 0.75
        }
      });
    }

    return result;
  }

  async rememberPreferredName(userId: string, name: string): Promise<void> {
    const normalizedName = normalizeName(name);
    if (!normalizedName) return;

    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "profile_preferred_name" } },
      update: {
        value: { name: normalizedName, source: "explicit" },
        confidence: 0.95
      },
      create: {
        userId,
        key: "profile_preferred_name",
        value: { name: normalizedName, source: "explicit" },
        confidence: 0.95
      }
    });
  }

  async rememberNameCandidate(
    userId: string,
    name: string | null | undefined,
    source: "google" | "asana"
  ): Promise<void> {
    const normalizedName = normalizeName(name ?? "");
    if (!normalizedName) return;

    const existing = await this.prisma.memoryEntry.findUnique({
      where: { userId_key: { userId, key: "profile_preferred_name" } }
    });
    const existingSource =
      existing?.value &&
      typeof existing.value === "object" &&
      typeof (existing.value as { source?: unknown }).source === "string"
        ? (existing.value as { source: string }).source
        : null;
    if (existingSource === "explicit") return;

    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "profile_preferred_name" } },
      update: {
        value: { name: normalizedName, source },
        confidence: 0.55
      },
      create: {
        userId,
        key: "profile_preferred_name",
        value: { name: normalizedName, source },
        confidence: 0.55
      }
    });
  }

  private async rememberAssistantResponsePreferences(
    userId: string,
    preferences: AssistantResponsePreferences
  ): Promise<void> {
    const existing = await this.prisma.memoryEntry.findUnique({
      where: { userId_key: { userId, key: "assistant_response_preferences" } }
    });
    const existingValue =
      existing?.value && typeof existing.value === "object"
        ? (existing.value as Record<string, unknown>)
        : {};
    const merged = {
      ...existingValue,
      ...preferences
    };

    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "assistant_response_preferences" } },
      update: {
        value: merged,
        confidence: 0.8
      },
      create: {
        userId,
        key: "assistant_response_preferences",
        value: merged,
        confidence: 0.8
      }
    });
  }
}

function extractPreferredName(text: string): string | null {
  const patterns = [
    /\bmy name is ([A-Za-z][A-Za-z.'-]{1,40}(?:\s+[A-Za-z][A-Za-z.'-]{1,40}){0,2})\b/i,
    /\bcall me ([A-Za-z][A-Za-z.'-]{1,40}(?:\s+[A-Za-z][A-Za-z.'-]{1,40}){0,2})\b/i,
    /\byou can call me ([A-Za-z][A-Za-z.'-]{1,40}(?:\s+[A-Za-z][A-Za-z.'-]{1,40}){0,2})\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractTimezone(text: string): string | null {
  const match = text.match(/\b(?:my timezone is|set my timezone to|use timezone) ([A-Za-z_/-]+)\b/i);
  return match?.[1] ?? null;
}

function extractAssistantResponsePreferences(text: string): AssistantResponsePreferences {
  const normalized = text.toLowerCase().replace(/[’]/g, "'");
  const hasPreferenceSignal =
    /\b(prefer|use|keep|be|make|answer|reply|respond|responses?|replies|style)\b/.test(
      normalized
    );
  if (!hasPreferenceSignal) return {};

  const preferences: AssistantResponsePreferences = {};
  if (/\b(concise|brief|short|succinct)\b/.test(normalized)) {
    preferences.verbosity = "concise";
  } else if (/\b(detailed|thorough|in depth|comprehensive)\b/.test(normalized)) {
    preferences.verbosity = "detailed";
  }

  if (/\bdirect\b/.test(normalized)) {
    preferences.tone = "direct";
  } else if (/\bfriendly\b/.test(normalized)) {
    preferences.tone = "friendly";
  } else if (/\bformal\b/.test(normalized)) {
    preferences.tone = "formal";
  }

  if (/\b(bullets?|bullet points?|lists?)\b/.test(normalized)) {
    preferences.format = "bullets";
  } else if (/\b(prose|paragraphs?)\b/.test(normalized)) {
    preferences.format = "prose";
  }

  if (
    /\b(minimal|fewer|no) follow-?ups\b/.test(normalized) ||
    /\bdon't suggest next steps\b/.test(normalized) ||
    /\bno suggestions\b/.test(normalized)
  ) {
    preferences.minimalFollowUps = true;
  }

  return preferences;
}

function normalizeName(name: string): string | null {
  const normalized = name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?,:;]+$/g, "");
  if (!normalized || normalized.length > 80) return null;
  if (!/[A-Za-z]/.test(normalized)) return null;
  return normalized;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
