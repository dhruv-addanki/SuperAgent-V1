import {
  AutomationRunStatus,
  AutomationStatus,
  type Automation,
  type Prisma,
  type PrismaClient
} from "@prisma/client";
import { addMinutes } from "date-fns";
import { UserFacingError } from "../../lib/errors";
import { formatForUser } from "../../lib/time";
import {
  computeNextRunAt,
  formatAutomationName,
  formatScheduleLabel,
  isValidTimezone,
  normalizeAutomationSchedule,
  type AutomationSchedule
} from "./schedule";

export interface CreateAutomationInput {
  userId: string;
  conversationId?: string | null;
  name?: string;
  prompt: string;
  schedule: AutomationSchedule;
  timezone: string;
  now?: Date;
}

export interface AutomationTargetInput {
  automationId?: string;
  number?: number;
  selector?: string;
}

export interface AutomationSummary {
  id: string;
  name: string;
  status: AutomationStatus;
  scheduleLabel: string;
  timezone: string;
  nextRunAt: Date;
  lastRunAt?: Date | null;
}

export type ClaimedAutomation = Prisma.AutomationGetPayload<{
  include: {
    user: true;
    conversation: true;
  };
}>;

export class AutomationService {
  constructor(private readonly prisma: PrismaClient) {}

  async createAutomation(input: CreateAutomationInput): Promise<Automation> {
    if (!isValidTimezone(input.timezone)) {
      throw new UserFacingError(
        "Invalid automation timezone",
        "AUTOMATION_INVALID_TIMEZONE",
        "I couldn't create that automation because the timezone is invalid."
      );
    }

    const schedule = normalizeAutomationSchedule(input.schedule);
    const nextRunAt = computeNextRunAt(schedule, input.timezone, input.now ?? new Date());
    const scheduleLabel = formatScheduleLabel(schedule, input.timezone);

    return this.prisma.automation.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId ?? null,
        name: formatAutomationName(input.name),
        prompt: input.prompt.trim(),
        schedule: schedule as unknown as Prisma.InputJsonValue,
        scheduleLabel,
        timezone: input.timezone,
        nextRunAt
      }
    });
  }

  async listAutomations(userId: string): Promise<AutomationSummary[]> {
    const automations = await this.prisma.automation.findMany({
      where: {
        userId,
        status: { not: AutomationStatus.DELETED }
      },
      orderBy: [
        { status: "asc" },
        { nextRunAt: "asc" },
        { createdAt: "asc" }
      ]
    });

    return automations.map(summarizeAutomation);
  }

  async rememberRecentAutomations(
    userId: string,
    automations: AutomationSummary[]
  ): Promise<void> {
    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "recent_automations" } },
      update: {
        value: automations.slice(0, 10).map(serializeAutomationSummary),
        confidence: 1
      },
      create: {
        userId,
        key: "recent_automations",
        value: automations.slice(0, 10).map(serializeAutomationSummary),
        confidence: 1
      }
    });
  }

  async pauseAutomation(userId: string, target: AutomationTargetInput): Promise<Automation> {
    const automation = await this.resolveAutomationTarget(userId, target);
    if (automation.status === AutomationStatus.PAUSED) return automation;
    return this.prisma.automation.update({
      where: { id: automation.id },
      data: {
        status: AutomationStatus.PAUSED,
        lockedAt: null,
        lockedBy: null,
        lockExpiresAt: null
      }
    });
  }

  async resumeAutomation(userId: string, target: AutomationTargetInput, now = new Date()): Promise<Automation> {
    const automation = await this.resolveAutomationTarget(userId, target);
    const schedule = normalizeAutomationSchedule(automation.schedule);
    return this.prisma.automation.update({
      where: { id: automation.id },
      data: {
        status: AutomationStatus.ACTIVE,
        nextRunAt: computeNextRunAt(schedule, automation.timezone, now),
        lockedAt: null,
        lockedBy: null,
        lockExpiresAt: null
      }
    });
  }

  async deleteAutomation(userId: string, target: AutomationTargetInput): Promise<Automation> {
    const automation = await this.resolveAutomationTarget(userId, target);
    return this.prisma.automation.update({
      where: { id: automation.id },
      data: {
        status: AutomationStatus.DELETED,
        lockedAt: null,
        lockedBy: null,
        lockExpiresAt: null
      }
    });
  }

  async claimDueAutomations(input: {
    now: Date;
    batchSize: number;
    workerId: string;
    lockMinutes?: number;
  }): Promise<ClaimedAutomation[]> {
    const lockExpiresAt = addMinutes(input.now, input.lockMinutes ?? 5);
    const candidates = await this.prisma.automation.findMany({
      where: dueAutomationWhere(input.now),
      orderBy: { nextRunAt: "asc" },
      take: input.batchSize
    });

    const claimed: ClaimedAutomation[] = [];
    for (const candidate of candidates) {
      const update = await this.prisma.automation.updateMany({
        where: {
          id: candidate.id,
          ...dueAutomationWhere(input.now)
        },
        data: {
          lockedAt: input.now,
          lockedBy: input.workerId,
          lockExpiresAt
        }
      });

      if (!update.count) continue;

      const automation = await this.prisma.automation.findUnique({
        where: { id: candidate.id },
        include: {
          user: true,
          conversation: true
        }
      });
      if (automation) claimed.push(automation);
    }

    return claimed;
  }

  async markRunSuccess(input: {
    automation: Automation;
    runId: string;
    outputText: string;
    now?: Date;
  }): Promise<void> {
    const now = input.now ?? new Date();
    await this.prisma.$transaction([
      this.prisma.automationRun.update({
        where: { id: input.runId },
        data: {
          status: AutomationRunStatus.SUCCESS,
          finishedAt: now,
          outputText: input.outputText
        }
      }),
      this.prisma.automation.update({
        where: { id: input.automation.id },
        data: nextRunUpdate(input.automation, now)
      })
    ]);
  }

  async markRunFailed(input: {
    automation: Automation;
    runId: string;
    errorMessage: string;
    outputText?: string;
    now?: Date;
  }): Promise<void> {
    const now = input.now ?? new Date();
    await this.prisma.$transaction([
      this.prisma.automationRun.update({
        where: { id: input.runId },
        data: {
          status: AutomationRunStatus.FAILED,
          finishedAt: now,
          outputText: input.outputText,
          errorMessage: input.errorMessage
        }
      }),
      this.prisma.automation.update({
        where: { id: input.automation.id },
        data: nextRunUpdate(input.automation, now)
      })
    ]);
  }

  async resolveAutomationTarget(
    userId: string,
    target: AutomationTargetInput
  ): Promise<Automation> {
    if (target.automationId) {
      const automation = await this.prisma.automation.findFirst({
        where: {
          id: target.automationId,
          userId,
          status: { not: AutomationStatus.DELETED }
        }
      });
      if (automation) return automation;
    }

    const memoryAutomationId = target.number
      ? await this.resolveAutomationIdFromMemory(userId, target.number)
      : null;
    if (memoryAutomationId) {
      const automation = await this.prisma.automation.findFirst({
        where: {
          id: memoryAutomationId,
          userId,
          status: { not: AutomationStatus.DELETED }
        }
      });
      if (automation) return automation;
    }

    const selector = target.selector?.trim();
    if (selector) {
      const matches = await this.prisma.automation.findMany({
        where: {
          userId,
          status: { not: AutomationStatus.DELETED },
          name: { contains: selector, mode: "insensitive" }
        },
        orderBy: { createdAt: "asc" },
        take: 3
      });
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        throw new UserFacingError(
          "Automation selection required",
          "AUTOMATION_SELECTION_REQUIRED",
          `I found multiple automations matching "${selector}". Ask me to list automations and pick a number.`
        );
      }
    }

    throw new UserFacingError(
      "Automation selection required",
      "AUTOMATION_SELECTION_REQUIRED",
      "Ask me to list automations, then pick the number to manage."
    );
  }

  private async resolveAutomationIdFromMemory(
    userId: string,
    number: number
  ): Promise<string | null> {
    const entry = await this.prisma.memoryEntry.findUnique({
      where: { userId_key: { userId, key: "recent_automations" } }
    });
    const automations = Array.isArray(entry?.value) ? entry.value : [];
    const selected = automations[number - 1];
    return selected &&
      typeof selected === "object" &&
      typeof (selected as { id?: unknown }).id === "string"
      ? (selected as { id: string }).id
      : null;
  }
}

export function formatAutomationList(
  automations: AutomationSummary[],
  timezone: string,
  options: { now?: Date; runnerEnabled?: boolean } = {}
): string {
  if (!automations.length) return "You don't have any active or paused automations.";

  const now = options.now ?? new Date();
  return [
    "Automations:",
    ...automations.map((automation, index) => {
      const status = automation.status === AutomationStatus.PAUSED ? "paused" : "active";
      const overdue =
        automation.status === AutomationStatus.ACTIVE &&
        automation.nextRunAt.getTime() <= now.getTime();
      const overdueLabel = overdue
        ? options.runnerEnabled === false
          ? " - overdue; automation runner is disabled"
          : " - overdue; waiting for runner"
        : "";
      return `${index + 1}. ${automation.name} - ${status} - ${automation.scheduleLabel} - next ${formatForUser(
        automation.nextRunAt,
        timezone
      )}${overdueLabel}`;
    })
  ].join("\n");
}

export function formatAutomationCreated(automation: Automation): string {
  return [
    `Created automation: ${automation.name}.`,
    `Runs: ${automation.scheduleLabel}.`,
    `Next run: ${formatForUser(automation.nextRunAt, automation.timezone)}.`
  ].join("\n");
}

export function formatAutomationConfirmation(input: {
  name?: string;
  prompt: string;
  schedule: AutomationSchedule;
  timezone: string;
}): string {
  const name = formatAutomationName(input.name);
  return [
    `Create automation "${name}"?`,
    `Runs: ${formatScheduleLabel(input.schedule, input.timezone)}.`,
    `It will: ${input.prompt.trim()}`,
    "Reply yes to create it, or cancel."
  ].join("\n");
}

export function summarizeAutomation(automation: Automation): AutomationSummary {
  return {
    id: automation.id,
    name: automation.name,
    status: automation.status,
    scheduleLabel: automation.scheduleLabel,
    timezone: automation.timezone,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt
  };
}

function serializeAutomationSummary(automation: AutomationSummary) {
  return {
    id: automation.id,
    name: automation.name,
    status: automation.status,
    scheduleLabel: automation.scheduleLabel,
    timezone: automation.timezone,
    nextRunAt: automation.nextRunAt.toISOString(),
    lastRunAt: automation.lastRunAt?.toISOString() ?? null
  };
}

function dueAutomationWhere(now: Date): Prisma.AutomationWhereInput {
  return {
    status: AutomationStatus.ACTIVE,
    nextRunAt: { lte: now },
    OR: [{ lockExpiresAt: null }, { lockExpiresAt: { lte: now } }]
  };
}

function nextRunUpdate(automation: Automation, now: Date): Prisma.AutomationUpdateInput {
  return {
    lastRunAt: now,
    nextRunAt: computeNextRunAt(automation.schedule, automation.timezone, now),
    lockedAt: null,
    lockedBy: null,
    lockExpiresAt: null
  };
}
