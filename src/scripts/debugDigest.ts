import { prisma } from "../modules/db/prisma";
import { ToolExecutor } from "../modules/agent/toolExecutor";
import { calendarOverviewWindow } from "../modules/agent/calendarReadShortcut";
import { getOrCreateWhatsAppConversation } from "../modules/agent/conversationState";
import { AsanaTokenService } from "../modules/asana/tokenService";
import { GoogleTokenService } from "../modules/google/tokenService";
import { NotionTokenService } from "../modules/notion/tokenService";
import { LongTermMemory } from "../modules/memory/longTermMemory";
import {
  buildDailyBriefingSnapshot,
  formatDailyBriefingDebug
} from "../modules/automation/dailyBriefing";

interface DebugDigestArgs {
  phone: string;
  date?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const user = await prisma.user.findUnique({
    where: { whatsappPhone: normalizePhone(args.phone) }
  });
  if (!user) throw new Error(`No user found for ${args.phone}`);

  const conversation = await getOrCreateWhatsAppConversation(prisma, user.id);
  const memory = new LongTermMemory(prisma);
  const memoryEntries = await memory.getRecentEntriesForContext(user.id, 50);
  const executor = new ToolExecutor(
    prisma,
    new GoogleTokenService(prisma),
    new AsanaTokenService(prisma),
    new NotionTokenService(prisma)
  );
  const baseDate = args.date ? new Date(`${args.date}T12:00:00`) : new Date();
  if (Number.isNaN(baseDate.getTime())) throw new Error(`Invalid --date: ${args.date}`);
  const calendarWindow = calendarOverviewWindow("today", user.timezone, baseDate);
  const context = {
    user,
    conversation,
    latestUserMessage: "debug daily digest"
  };
  const [gmailResult, calendarResult, asanaResult] = await Promise.all([
    executor.executeToolCall(
      "gmail_search_threads",
      {
        query: "in:inbox newer_than:2d",
        maxResults: 15
      },
      context,
      { force: true }
    ),
    executor.executeToolCall(
      "calendar_list_events",
      {
        timeMin: calendarWindow.timeMin,
        timeMax: calendarWindow.timeMax,
        maxResults: 50
      },
      context,
      { force: true }
    ),
    executor.executeToolCall(
      "asana_list_my_tasks",
      {
        completed: false,
        limit: 50,
        sortBy: "due",
        sortDirection: "asc"
      },
      context,
      { force: true }
    )
  ]);

  const snapshot = buildDailyBriefingSnapshot({
    gmailResult,
    calendarResult,
    asanaResult,
    memoryEntries,
    timezone: user.timezone,
    now: baseDate
  });
  console.log(formatDailyBriefingDebug(snapshot));
}

function parseArgs(argv: string[]): DebugDigestArgs {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    parsed[key] = value;
    index += 1;
  }
  if (!parsed.phone) throw new Error("Missing --phone.");
  return {
    phone: parsed.phone,
    date: parsed.date
  };
}

function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  return trimmed.startsWith("+") ? trimmed : `+${trimmed.replace(/\D/g, "")}`;
}

if (process.argv[1]?.endsWith("debugDigest.ts") || process.argv[1]?.endsWith("debugDigest.js")) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
