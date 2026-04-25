import type { PrismaClient, User } from "@prisma/client";
import { env } from "../../config/env";

export type SetupIntegrationKey = "google" | "asana" | "notion";

export interface SetupIntegrationStatus {
  key: SetupIntegrationKey;
  label: string;
  connected: boolean;
  detail?: string;
  connectUrl?: string;
}

export interface SetupStatus {
  phone: string;
  integrations: SetupIntegrationStatus[];
  hasAnyConnected: boolean;
  allConnected: boolean;
}

export class SetupStatusService {
  constructor(private readonly prisma: PrismaClient) {}

  async getStatus(
    user: Pick<User, "id" | "whatsappPhone"> & { googleEmail?: string | null }
  ): Promise<SetupStatus> {
    const prisma = this.prisma as any;
    const [googleAccount, asanaAccount, notionAccount] = await Promise.all([
      prisma.googleAccount?.findUnique?.({ where: { userId: user.id } }) ?? null,
      prisma.asanaAccount?.findUnique?.({ where: { userId: user.id } }) ?? null,
      prisma.notionAccount?.findUnique?.({ where: { userId: user.id } }) ?? null
    ]);

    const integrations: SetupIntegrationStatus[] = [
      {
        key: "google",
        label: "Google",
        connected: Boolean(googleAccount),
        detail: user.googleEmail ?? undefined,
        connectUrl: googleAccount ? undefined : connectUrl("/auth/google/start", user.whatsappPhone)
      },
      {
        key: "asana",
        label: "Asana",
        connected: Boolean(asanaAccount),
        detail: asanaAccount?.asanaName ?? asanaAccount?.asanaEmail ?? undefined,
        connectUrl: asanaAccount ? undefined : connectUrl("/auth/asana/start", user.whatsappPhone)
      },
      {
        key: "notion",
        label: "Notion",
        connected: Boolean(notionAccount),
        detail: notionAccount?.workspaceName ?? undefined,
        connectUrl: notionAccount ? undefined : connectUrl("/auth/notion/start", user.whatsappPhone)
      }
    ];

    return {
      phone: user.whatsappPhone,
      integrations,
      hasAnyConnected: integrations.some((integration) => integration.connected),
      allConnected: integrations.every((integration) => integration.connected)
    };
  }
}

export function isSetupStatusRequest(text: string): boolean {
  const normalized = normalizeMessage(text);
  return (
    /^(setup|set up|connect|connections|integrations|status)$/.test(normalized) ||
    /^(?:show|check|view) (?:my )?(?:setup|connections|integrations|connected accounts|account status)$/.test(normalized) ||
    /^what(?:'s| is) connected$/.test(normalized) ||
    /^which (?:accounts|integrations) (?:are )?connected$/.test(normalized) ||
    /^help (?:me )?(?:setting|set) up$/.test(normalized) ||
    /^(?:connect|reconnect) (?:my )?(?:accounts|integrations|google|asana|notion)$/.test(normalized) ||
    /^(?:connect|reconnect) (?:my )?.*\b(?:google|asana|notion|accounts|integrations)\b/.test(normalized)
  );
}

export function isGreetingOnly(text: string): boolean {
  return /^(hi|hello|hey|yo|start|good morning|good afternoon|good evening)(?: there)?$/.test(
    normalizeMessage(text)
  );
}

export function formatSetupStatusForWhatsApp(status: SetupStatus): string {
  const lines = ["Setup status:"];

  for (const integration of status.integrations) {
    if (integration.connected) {
      lines.push(
        `- ${integration.label}: connected${integration.detail ? ` (${integration.detail})` : ""}`
      );
    } else {
      lines.push(`- ${integration.label}: not connected`);
      if (integration.connectUrl) lines.push(`  Connect: ${integration.connectUrl}`);
    }
  }

  lines.push("", "Google powers Calendar, Gmail, Drive, and Docs.");
  if (status.allConnected) lines.push("All current integrations are connected.");
  return lines.join("\n");
}

export function formatSetupHintForWhatsApp(status: SetupStatus): string {
  const missing = status.integrations
    .filter((integration) => !integration.connected)
    .map((integration) => integration.label)
    .join(", ");
  return missing
    ? `For full setup, reply setup to connect ${missing}.`
    : "All current integrations are connected.";
}

export function setupStatusProfileLines(status: SetupStatus, timezone: string): string[] {
  const connected = status.integrations
    .filter((integration) => integration.connected)
    .map((integration) =>
      integration.detail ? `${integration.label} (${integration.detail})` : integration.label
    );
  const missing = status.integrations
    .filter((integration) => !integration.connected)
    .map((integration) => integration.label);

  return [
    `Timezone: ${timezone}`,
    `Connected integrations: ${connected.length ? connected.join(", ") : "None"}`,
    `Missing integrations: ${missing.length ? missing.join(", ") : "None"}`
  ];
}

function connectUrl(path: string, phone: string): string {
  const url = new URL(path, env.APP_BASE_URL);
  url.searchParams.set("phone", phone);
  return url.toString();
}

function normalizeMessage(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}
