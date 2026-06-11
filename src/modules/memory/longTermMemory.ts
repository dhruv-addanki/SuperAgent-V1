import type { PrismaClient, User } from "@prisma/client";
import type { PromptMemoryEntry } from "../agent/conversationContext";
import type { AsanaPriorityProfile, DigestFilterRule } from "../automation/dailyBriefing";

interface MemoryExtractionResult {
  timezone?: string;
  responsePreferences?: AssistantResponsePreferences;
  digestRulesUpdated?: boolean;
  asanaPriorityUpdated?: boolean;
  projectNamingUpdated?: boolean;
}

export interface AssistantResponsePreferences {
  verbosity?: "concise" | "detailed";
  tone?: "direct" | "friendly" | "formal" | "casual" | "warm" | "professional" | "calm" | "playful";
  format?: "bullets" | "prose";
  minimalFollowUps?: boolean;
  humanLike?: boolean;
  avoidEmDashes?: boolean;
  avoidHyphenSeparators?: boolean;
  style?: string;
  personality?: string;
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
      result.responsePreferences = responsePreferences;
    }

    const excludedCalendarNames = extractExcludedCalendarNames(text);
    if (excludedCalendarNames.length) {
      await this.rememberExcludedCalendarNames(user.id, excludedCalendarNames);
    }

    const digestFilterRules = extractDigestFilterRules(text);
    if (digestFilterRules.length) {
      await this.rememberDigestFilterRules(user.id, digestFilterRules);
      result.digestRulesUpdated = true;
    }

    const asanaPriorityProfile = extractAsanaPriorityProfileUpdate(text);
    if (asanaPriorityProfile) {
      await this.rememberAsanaPriorityProfile(user.id, asanaPriorityProfile);
      result.asanaPriorityUpdated = true;
    }

    const projectNamingPreference = extractProjectNamingPreference(text);
    if (projectNamingPreference) {
      await this.rememberProjectNamingPreference(user.id, projectNamingPreference);
      result.projectNamingUpdated = true;
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

  private async rememberExcludedCalendarNames(
    userId: string,
    calendarNames: string[]
  ): Promise<void> {
    const existing = await this.prisma.memoryEntry.findUnique({
      where: { userId_key: { userId, key: "calendar_exclusion_preferences" } }
    });
    const existingNames =
      existing?.value &&
      typeof existing.value === "object" &&
      Array.isArray((existing.value as { excludedCalendarNames?: unknown }).excludedCalendarNames)
        ? (existing.value as { excludedCalendarNames: unknown[] }).excludedCalendarNames
            .filter((value): value is string => typeof value === "string")
            .map(normalizeCalendarNameForStorage)
            .filter(Boolean)
        : [];
    const merged = Array.from(
      new Map(
        [
          ...existingNames,
          ...calendarNames.map(normalizeCalendarNameForStorage).filter(Boolean)
        ].map((name) => [name.toLowerCase(), name])
      ).values()
    );

    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "calendar_exclusion_preferences" } },
      update: {
        value: { excludedCalendarNames: merged },
        confidence: 0.9
      },
      create: {
        userId,
        key: "calendar_exclusion_preferences",
        value: { excludedCalendarNames: merged },
        confidence: 0.9
      }
    });
  }

  private async rememberDigestFilterRules(
    userId: string,
    rules: DigestFilterRule[]
  ): Promise<void> {
    const existing = await this.prisma.memoryEntry.findUnique({
      where: { userId_key: { userId, key: "digest_filter_rules" } }
    });
    const existingRules =
      existing?.value &&
      typeof existing.value === "object" &&
      Array.isArray((existing.value as { rules?: unknown }).rules)
        ? (existing.value as { rules: unknown[] }).rules.filter(isDigestFilterRule)
        : [];
    const merged = dedupeDigestFilterRules([...existingRules, ...rules]);

    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "digest_filter_rules" } },
      update: {
        value: { rules: merged } as any,
        confidence: 0.9
      },
      create: {
        userId,
        key: "digest_filter_rules",
        value: { rules: merged } as any,
        confidence: 0.9
      }
    });
  }

  private async rememberAsanaPriorityProfile(
    userId: string,
    update: AsanaPriorityProfile
  ): Promise<void> {
    const existing = await this.prisma.memoryEntry.findUnique({
      where: { userId_key: { userId, key: "asana_priority_profile" } }
    });
    const current =
      existing?.value && typeof existing.value === "object"
        ? (existing.value as AsanaPriorityProfile)
        : {};
    const merged: AsanaPriorityProfile = {
      categoryWeights: {
        ...(current.categoryWeights ?? {}),
        ...(update.categoryWeights ?? {})
      },
      projectWeights: {
        ...(current.projectWeights ?? {}),
        ...(update.projectWeights ?? {})
      },
      taskPatternWeights: [
        ...(current.taskPatternWeights ?? []),
        ...(update.taskPatternWeights ?? [])
      ].slice(-50)
    };

    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "asana_priority_profile" } },
      update: {
        value: merged as any,
        confidence: 0.85
      },
      create: {
        userId,
        key: "asana_priority_profile",
        value: merged as any,
        confidence: 0.85
      }
    });
  }

  private async rememberProjectNamingPreference(
    userId: string,
    preference: ProjectNamingPreference
  ): Promise<void> {
    const existing = await this.prisma.memoryEntry.findUnique({
      where: { userId_key: { userId, key: "project_naming_preferences" } }
    });
    const existingPreferences =
      existing?.value &&
      typeof existing.value === "object" &&
      Array.isArray((existing.value as { preferences?: unknown }).preferences)
        ? (existing.value as { preferences: unknown[] }).preferences.filter(isProjectNamingPreference)
        : [];
    const merged = dedupeProjectNamingPreferences([...existingPreferences, preference]).slice(-20);

    await this.prisma.memoryEntry.upsert({
      where: { userId_key: { userId, key: "project_naming_preferences" } },
      update: {
        value: { preferences: merged } as any,
        confidence: 0.85
      },
      create: {
        userId,
        key: "project_naming_preferences",
        value: { preferences: merged } as any,
        confidence: 0.85
      }
    });
  }
}

interface ProjectNamingPreference {
  currentName: string;
  previousName?: string;
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
  const match = text.match(
    /\b(?:my timezone is|set my timezone to|use timezone) ([A-Za-z_/-]+)\b/i
  );
  return match?.[1] ?? null;
}

function extractAssistantResponsePreferences(text: string): AssistantResponsePreferences {
  const normalized = text.toLowerCase().replace(/[’]/g, "'");
  const hasPreferenceSignal =
    /\b(prefer|use|keep|be|make|answer|reply|respond|responses?|replies|style|tone|voice|vibe|personality|sound|talk|speak|write)\b/.test(
      normalized
    ) || /\bem\s*dashes?\b|\bemdashes?\b|—|\bin text casually\b/.test(normalized);
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
  } else if (/\bcasual\b/.test(normalized)) {
    preferences.tone = "casual";
  } else if (/\bwarm\b/.test(normalized)) {
    preferences.tone = "warm";
  } else if (/\bprofessional\b/.test(normalized)) {
    preferences.tone = "professional";
  } else if (/\bcalm\b/.test(normalized)) {
    preferences.tone = "calm";
  } else if (/\bplayful\b/.test(normalized)) {
    preferences.tone = "playful";
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

  if (
    /\bhuman[-\s]?like\b/.test(normalized) ||
    /\bmore natural\b/.test(normalized) ||
    /\bless robotic\b/.test(normalized) ||
    /\bsound like (?:a )?(?:real )?person\b/.test(normalized)
  ) {
    preferences.humanLike = true;
  }

  if (
    /\b(?:no|avoid|don't use|do not use|never use)\s+(?:em\s*dashes?|emdashes?|—)\b/.test(
      normalized
    )
  ) {
    preferences.avoidEmDashes = true;
  }

  if (
    /\b(?:no|avoid|don't use|do not use|dont use|never use)\s+(?:casual\s+)?(?:hyphens?|dashes?|-)\b/.test(
      normalized
    ) ||
    /\b(?:hyphens?|dashes?)\s+in text casually\b/.test(normalized) ||
    /(?:^|\s)-\s+in text casually\b/.test(normalized) ||
    /\b(?:don't use|do not use|dont use|never use)\s+-\s+/.test(normalized)
  ) {
    preferences.avoidHyphenSeparators = true;
  }

  const style = extractStylePreference(text);
  if (style) preferences.style = style;

  const personality = extractPersonalityPreference(text);
  if (personality) preferences.personality = personality;

  return preferences;
}

function extractExcludedCalendarNames(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[’]/g, "'");
  const hasCalendarSignal =
    /\b(cal|calendar|calendars|events?|schedule|agenda|digest|digests?|summaries|summary)\b/.test(
      normalized
    );
  const hasExclusionSignal =
    /\b(don't|dont|do not|never|exclude|ignore|skip|leave out|disinclude)\b/.test(normalized) &&
    /\b(use|include|show|pull|read|count|calendar|calendars|events?|schedule|agenda|digest|digests?|summaries|summary)\b/.test(
      normalized
    );
  if (!hasCalendarSignal || !hasExclusionSignal) return [];

  const names = new Set<string>();
  const quotedPatterns = [
    /\bcalendar\s+(?:called|named)\s+['"]([^'"]{2,80})['"]/gi,
    /\b(?:called|named)\s+['"]([^'"]{2,80})['"]\s+calendar\b/gi,
    /['"]([^'"]{2,80})['"]\s+calendar\b/gi,
    /\bcalendar\s+['"]([^'"]{2,80})['"]/gi
  ];

  for (const pattern of quotedPatterns) {
    for (const match of text.matchAll(pattern)) {
      const name = normalizeCalendarNameForStorage(match[1] ?? "");
      if (name) names.add(name);
    }
  }

  if (!names.size) {
    const unquotedPatterns = [
      /\b(?:exclude|ignore|skip|leave out|disinclude)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9 &'._-]{1,80}?)\s+calendar\b/gi,
      /\b(?:don't|dont|do not|never)\s+(?:use|include|show|pull|read|count)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9 &'._-]{1,80}?)\s+calendar\b/gi,
      /\b(?:exclude|ignore|skip|leave out|disinclude)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9 &'._-]{1,80}?)\s+from\s+(?:my\s+)?(?:basic\s+)?(?:summaries|summary|digests?|daily digest|morning digest|calendar summaries|schedule|agenda)\b/gi,
      /\b(?:don't|dont|do not|never)\s+(?:use|include|show|pull|read|count)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9 &'._-]{1,80}?)\s+(?:in|for|from)\s+(?:my\s+)?(?:basic\s+)?(?:summaries|summary|digests?|daily digest|morning digest|calendar summaries|schedule|agenda)\b/gi
    ];

    for (const pattern of unquotedPatterns) {
      for (const match of text.matchAll(pattern)) {
        const name = normalizeCalendarNameForStorage(match[1] ?? "");
        if (name) names.add(name);
      }
    }
  }

  return Array.from(names);
}

function extractDigestFilterRules(text: string): DigestFilterRule[] {
  const normalized = text.toLowerCase().replace(/[’]/g, "'");
  const rules: DigestFilterRule[] = [];
  const hasDigestScope =
    /\b(digest|digests|summary|summaries|brief|briefing|morning|automation)\b/.test(normalized);
  const exclusionSignal =
    /\b(don't|dont|do not|never|exclude|ignore|skip|leave out|hide|stop showing|don't mention|dont mention)\b/.test(
      normalized
    );
  const readSignal = /\b(i already read|already read|i read|read that|handled that)\b/.test(
    normalized
  );
  const lowPrioritySignal = /\b(low priority|not important|less important|downrank)\b/.test(
    normalized
  );

  if (exclusionSignal && hasDigestScope) {
    const targets = extractDigestRuleTargets(text);
    const domains = inferDigestDomains(normalized);
    for (const target of targets) {
      for (const domain of domains) {
        rules.push(
          buildDigestRule(domain, "exclude_from_digest", target, "Explicit digest exclusion")
        );
      }
    }
  }

  if (
    /\b(ignore|skip|omit|don't include|dont include)\b.*\b(newsletters?|promos?|promotions)\b/.test(
      normalized
    )
  ) {
    rules.push({
      domain: "gmail",
      behavior: "downrank",
      scope: "scheduled_digest",
      match: { emailCategory: "newsletter", text: "newsletter" },
      reason: "User downranked newsletters/promotions",
      source: "explicit",
      createdAt: new Date().toISOString()
    });
    rules.push({
      domain: "gmail",
      behavior: "downrank",
      scope: "scheduled_digest",
      match: { emailCategory: "promotions", text: "promotions" },
      reason: "User downranked newsletters/promotions",
      source: "explicit",
      createdAt: new Date().toISOString()
    });
  }

  if (readSignal) {
    const targets = extractDigestRuleTargets(text);
    for (const target of targets) {
      rules.push(
        buildDigestRule(
          "gmail",
          "downrank",
          target,
          "User said this email was already read/handled"
        )
      );
    }
  }

  if (lowPrioritySignal) {
    const targets = extractDigestRuleTargets(text);
    for (const target of targets) {
      rules.push(buildDigestRule("all", "downrank", target, "User marked this low priority"));
    }
  }

  return dedupeDigestFilterRules(rules);
}

function extractAsanaPriorityProfileUpdate(text: string): AsanaPriorityProfile | null {
  const normalized = text.toLowerCase().replace(/[’]/g, "'");
  if (!/\b(asana|task|tasks|project|priority|important)\b/.test(normalized)) return null;

  const profile: AsanaPriorityProfile = {
    categoryWeights: {},
    projectWeights: {},
    taskPatternWeights: []
  };
  const high = /\b(high priority|important|prioritize|highest priority|matters?|critical)\b/.test(
    normalized
  );
  const low = /\b(low priority|not important|less important|deprioritize|downrank)\b/.test(
    normalized
  );
  if (!high && !low) return null;
  const weight = high ? 28 : -24;

  const knownCategories = [
    "school",
    "job",
    "career",
    "admin",
    "scanis",
    "content",
    "habit",
    "test"
  ];
  for (const category of knownCategories) {
    if (new RegExp(`\\b${category}\\b`).test(normalized)) {
      profile.categoryWeights![category] = weight;
    }
  }

  const projectMatch = text.match(
    /\b(?:project|asana project)\s+["']?([A-Za-z0-9][A-Za-z0-9 _&.'-]{1,80})["']?\s+(?:is|as|should be|matters|counts)/i
  );
  if (projectMatch?.[1]) {
    profile.projectWeights![normalizePriorityKey(projectMatch[1])] = weight;
  }

  const namedMatch = text.match(
    /\b(?:treat|mark|remember)\s+["']?([A-Za-z0-9][A-Za-z0-9 _&.'-]{1,80})["']?\s+(?:as|is)\s+(?:a\s+)?(?:high|low|important|not important)/i
  );
  if (namedMatch?.[1]) {
    profile.taskPatternWeights!.push({
      pattern: namedMatch[1].trim(),
      weight,
      reason: high ? "user-marked-important" : "user-marked-low-priority"
    });
  }

  const hasAny =
    Object.keys(profile.categoryWeights ?? {}).length ||
    Object.keys(profile.projectWeights ?? {}).length ||
    (profile.taskPatternWeights ?? []).length;
  return hasAny ? profile : null;
}

function extractProjectNamingPreference(text: string): ProjectNamingPreference | null {
  const match = text.match(
    /\b(?:the\s+)?(?:name|project\s+name)\s+(?:was\s+)?(?:switched|changed|renamed)\s+to\s+["']?([A-Za-z0-9][A-Za-z0-9 _&.'-]{1,80})["']?/i
  );
  if (!match?.[1]) return null;
  const currentName = normalizeProjectName(match[1]);
  if (!currentName) return null;

  const previousMatch = text.match(
    /\b(?:from|formerly|old\s+name\s+was|used\s+to\s+be)\s+["']?([A-Za-z0-9][A-Za-z0-9 _&.'-]{1,80})["']?/i
  );
  const previousName = previousMatch?.[1] ? normalizeProjectName(previousMatch[1]) : undefined;

  return {
    currentName,
    ...(previousName ? { previousName } : {})
  };
}

function normalizeProjectName(value: string): string {
  return value
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isProjectNamingPreference(value: unknown): value is ProjectNamingPreference {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { currentName?: unknown }).currentName === "string"
  );
}

function dedupeProjectNamingPreferences(
  preferences: ProjectNamingPreference[]
): ProjectNamingPreference[] {
  const deduped = new Map<string, ProjectNamingPreference>();
  for (const preference of preferences) {
    deduped.set(preference.currentName.toLowerCase(), preference);
  }
  return Array.from(deduped.values());
}

function buildDigestRule(
  domain: DigestFilterRule["domain"],
  behavior: DigestFilterRule["behavior"],
  target: string,
  reason: string
): DigestFilterRule {
  const normalizedTarget = target.trim();
  const base = {
    id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    domain,
    behavior,
    scope: "scheduled_digest" as const,
    reason,
    source: "explicit",
    createdAt: new Date().toISOString()
  };

  if (domain === "calendar") {
    return {
      ...base,
      match: {
        text: normalizedTarget,
        calendarName: normalizedTarget,
        eventTitle: normalizedTarget
      }
    };
  }
  if (domain === "gmail") {
    return {
      ...base,
      match: { text: normalizedTarget, emailSubject: normalizedTarget, emailFrom: normalizedTarget }
    };
  }
  if (domain === "asana") {
    return {
      ...base,
      match: {
        text: normalizedTarget,
        asanaProject: normalizedTarget,
        asanaTag: normalizedTarget,
        taskNamePattern: normalizedTarget
      }
    };
  }
  return {
    ...base,
    match: { text: normalizedTarget }
  };
}

function inferDigestDomains(normalized: string): DigestFilterRule["domain"][] {
  const domains = new Set<DigestFilterRule["domain"]>();
  if (/\b(calendar|cal|event|events|schedule|agenda|class|exam|final|phys|cs)\b/.test(normalized)) {
    domains.add("calendar");
  }
  if (/\b(email|gmail|inbox|newsletter|promo|from)\b/.test(normalized)) {
    domains.add("gmail");
  }
  if (/\b(asana|task|tasks|project)\b/.test(normalized)) {
    domains.add("asana");
  }
  if (!domains.size) domains.add("all");
  return Array.from(domains);
}

function extractDigestRuleTargets(text: string): string[] {
  const targets = new Set<string>();
  const quoted = text.match(/["'“”‘’]([^"'“”‘’]{2,120})["'“”‘’]/g) ?? [];
  for (const value of quoted) {
    const cleaned = normalizeRuleTarget(value.replace(/^["'“”‘’]+|["'“”‘’]+$/g, ""));
    if (cleaned) targets.add(cleaned);
  }

  const patterns = [
    /\b(?:exclude|ignore|skip|hide|leave out|don't include|dont include|do not include|never include|don't mention|dont mention)\s+(?:the\s+)?([^.!?\n]{2,140}?)(?:\s+(?:from|in|for)\s+(?:my\s+)?(?:daily\s+)?(?:digest|digests|summary|summaries|briefing)|[.!?\n]|$)/gi,
    /\b(?:i already read|already read|i read|handled)\s+(?:the\s+)?([^.!?\n]{2,140})(?:[.!?\n]|$)/gi,
    /\b([^.!?\n]{2,100}?)\s+(?:is|are)\s+(?:low priority|not important|less important)\b/gi
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const cleaned = normalizeRuleTarget(match[1] ?? "");
      if (cleaned) targets.add(cleaned);
    }
  }

  if (!targets.size && /\b(newsletters?|promos?|promotions)\b/i.test(text)) {
    targets.add("newsletters");
    targets.add("promotions");
  }

  return Array.from(targets).slice(0, 8);
}

function normalizeRuleTarget(value: string): string | null {
  const cleaned = value
    .replace(
      /\b(?:from|in|for)\s+(?:my\s+)?(?:daily\s+)?(?:digest|digests|summary|summaries|briefing).*$/i,
      ""
    )
    .replace(/\b(?:calendar|events?|emails?|gmail|asana|tasks?)$/i, "")
    .replace(/[.,!?;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 2 || cleaned.length > 140) return null;
  return cleaned;
}

function isDigestFilterRule(value: unknown): value is DigestFilterRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Partial<DigestFilterRule>;
  return Boolean(rule.domain && rule.behavior && rule.scope && rule.match);
}

function dedupeDigestFilterRules(rules: DigestFilterRule[]): DigestFilterRule[] {
  const map = new Map<string, DigestFilterRule>();
  for (const rule of rules) {
    const key = JSON.stringify({
      domain: rule.domain,
      behavior: rule.behavior,
      scope: rule.scope,
      match: rule.match
    }).toLowerCase();
    map.set(key, rule);
  }
  return Array.from(map.values()).slice(-100);
}

function normalizePriorityKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeCalendarNameForStorage(value: string): string {
  return value
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/\s+calendar$/i, "")
    .replace(/[.,!?;:]+$/g, "")
    .trim();
}

function extractStylePreference(text: string): string | null {
  const patterns = [
    /\b(?:use|match|switch to|set|make)\s+(?:a\s+)?([^.!?\n]{2,120}?)\s+(?:style|tone|voice|vibe)\b/i,
    /\b(?:respond|reply|talk|speak|write|sound)\s+(?:more\s+)?(?:like|in)\s+(?:a\s+)?([^.!?\n]{2,120})(?:[.!?\n]|$)/i,
    /\b(?:set|change)\s+(?:your\s+)?(?:style|tone|voice|vibe)\s+(?:to|as|like)\s+([^.!?\n]{2,120})(?:[.!?\n]|$)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const normalized = normalizeStyleText(match?.[1] ?? "");
    if (normalized) return normalized;
  }
  return null;
}

function extractPersonalityPreference(text: string): string | null {
  const patterns = [
    /\b(?:set|change)\s+(?:your\s+)?personality\s+(?:to|as|like)\s+([^.!?\n]{2,120})(?:[.!?\n]|$)/i,
    /\b(?:your\s+)?personality\s+(?:should be|is)\s+([^.!?\n]{2,120})(?:[.!?\n]|$)/i,
    /\b(?:be|act)\s+(?:more\s+)?([^.!?\n]{2,120}?)\s+(?:as an assistant|when you reply|in replies)\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const normalized = normalizeStyleText(match?.[1] ?? "");
    if (normalized) return normalized;
  }
  return null;
}

function normalizeStyleText(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/\bplease\b\.?$/i, "")
    .replace(/[.!?,:;]+$/g, "")
    .trim();
  if (!normalized || normalized.length > 120) return null;
  if (!/[A-Za-z]/.test(normalized)) return null;
  return normalized;
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
