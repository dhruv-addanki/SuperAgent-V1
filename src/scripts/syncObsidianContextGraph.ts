import { prisma } from "../modules/db/prisma";
import { ObsidianContextGraphService } from "../modules/contextGraph/obsidianContextGraphService";

interface Args {
  userId?: string;
  phone?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const user = await resolveUser(args);
  const service = new ObsidianContextGraphService(prisma);
  const result = await service.syncForUser(user.id);

  if (!result.enabled) {
    console.log(`Obsidian context graph sync skipped: ${result.reason ?? "disabled"}`);
    return;
  }

  console.log(
    [
      "Obsidian context graph synced.",
      `User: ${user.id}`,
      `Path: ${result.graphPath}`,
      `Indexed: ${result.indexedCount}`,
      `Deleted stale index rows: ${result.deletedCount}`,
      `Skipped files: ${result.skippedCount}`
    ].join("\n")
  );
}

async function resolveUser(args: Args): Promise<{ id: string; whatsappPhone: string }> {
  if (args.userId) {
    const user = await prisma.user.findUnique({ where: { id: args.userId } });
    if (!user) throw new Error(`No user found for id ${args.userId}`);
    return user;
  }

  if (args.phone) {
    const user = await prisma.user.findUnique({
      where: { whatsappPhone: normalizePhone(args.phone) }
    });
    if (!user) throw new Error(`No user found for phone ${args.phone}`);
    return user;
  }

  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" }, take: 2 });
  if (users.length === 1 && users[0]) return users[0];
  if (!users.length)
    throw new Error("No users exist yet. Send the agent a WhatsApp message first.");
  throw new Error("Multiple users exist. Pass --user-id <id> or --phone <phone>.");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--user-id") {
      args.userId = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--phone") {
      args.phone = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function normalizePhone(phone: string): string {
  return phone.trim().replace(/[^\d+]/g, "");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
