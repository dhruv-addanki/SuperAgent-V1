import type { PrismaClient, User } from "@prisma/client";
import { env } from "../../config/env";
import { detectReferencedApps, type ReferencedApp } from "./compoundIntent";

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
      lookupAccount(prisma.googleAccount, user.id),
      lookupAccount(prisma.asanaAccount, user.id),
      lookupAccount(prisma.notionAccount, user.id)
    ]);

    const integrations: SetupIntegrationStatus[] = [
      {
        key: "google",
        label: "Google",
        connected: googleAccount === undefined ? true : Boolean(googleAccount),
        detail: user.googleEmail ?? undefined,
        connectUrl: googleAccount === null ? connectUrl("/auth/google/start", user.whatsappPhone) : undefined
      },
      {
        key: "asana",
        label: "Asana",
        connected: asanaAccount === undefined ? true : Boolean(asanaAccount),
        detail: asanaAccount?.asanaName ?? asanaAccount?.asanaEmail ?? undefined,
        connectUrl: asanaAccount === null ? connectUrl("/auth/asana/start", user.whatsappPhone) : undefined
      },
      {
        key: "notion",
        label: "Notion",
        connected: notionAccount === undefined ? true : Boolean(notionAccount),
        detail: notionAccount?.workspaceName ?? undefined,
        connectUrl: notionAccount === null ? connectUrl("/auth/notion/start", user.whatsappPhone) : undefined
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

export function missingIntegrationsForRequest(
  text: string,
  status: SetupStatus
): SetupIntegrationStatus[] {
  const required = new Set(
    detectReferencedApps(text)
      .map(integrationForApp)
      .filter((integration): integration is SetupIntegrationKey => Boolean(integration))
  );

  if (!required.size) return [];
  return status.integrations.filter(
    (integration) => required.has(integration.key) && !integration.connected
  );
}

export function formatMissingIntegrationForWhatsApp(
  integration: SetupIntegrationStatus
): string {
  return integration.connectUrl
    ? `Connect ${integration.label} first: ${integration.connectUrl}`
    : `Connect ${integration.label} first.`;
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
    `Missing integrations: ${missing.length ? missing.join(", ") : "None"}`,
    ...status.integrations
      .filter((integration) => !integration.connected && integration.connectUrl)
      .map((integration) => `${integration.label} connect link: ${integration.connectUrl}`)
  ];
}

function integrationForApp(app: ReferencedApp): SetupIntegrationKey | null {
  if (app === "notion") return "notion";
  if (app === "asana") return "asana";
  if (app === "calendar" || app === "gmail" || app === "drive" || app === "docs") {
    return "google";
  }
  return null;
}

function connectUrl(path: string, phone: string): string {
  const url = new URL(path, env.APP_BASE_URL);
  url.searchParams.set("phone", phone);
  return url.toString();
}

async function lookupAccount(
  delegate: { findUnique?: (input: { where: { userId: string } }) => Promise<unknown> } | undefined,
  userId: string
): Promise<any | null | undefined> {
  if (!delegate?.findUnique) return undefined;
  return delegate.findUnique({ where: { userId } });
}

function normalizeMessage(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}
