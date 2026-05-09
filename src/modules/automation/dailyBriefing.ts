import type { PromptMemoryEntry } from "../agent/conversationContext";
import type { ToolExecutionResult } from "../agent/toolExecutor";
import type { AsanaTaskSummary } from "../asana/asanaTypes";
import type { CalendarEventSummary, GmailThreadSummary } from "../google/googleTypes";

export type DigestFilterDomain = "calendar" | "gmail" | "asana" | "all";
export type DigestFilterBehavior =
  | "exclude_from_digest"
  | "include_only_on_direct_ask"
  | "downrank"
  | "always_include";
export type DigestFilterScope = "scheduled_digest" | "generic_summary" | "all_reads";

export interface DigestFilterRule {
  id?: string;
  domain: DigestFilterDomain;
  behavior: DigestFilterBehavior;
  scope: DigestFilterScope;
  match: {
    text?: string;
    calendarName?: string;
    eventTitle?: string;
    emailSubject?: string;
    emailFrom?: string;
    emailCategory?: string;
    asanaProject?: string;
    asanaTag?: string;
    taskNamePattern?: string;
  };
  reason?: string;
  source?: string;
  createdAt?: string;
}

export interface AsanaPriorityProfile {
  categoryWeights?: Record<string, number>;
  projectWeights?: Record<string, number>;
  taskPatternWeights?: Array<{
    pattern: string;
    weight: number;
    reason?: string;
  }>;
}

export interface DailyBriefingFact {
  id: string;
  source: "calendar" | "gmail" | "asana";
  title: string;
  summary?: string;
  sourceName?: string;
  start?: string;
  end?: string;
  dueOn?: string;
  unread?: boolean;
  category?: string;
  projectName?: string;
  score: number;
  reasons: string[];
  filtered?: boolean;
  filterReason?: string;
  provenance: Record<string, unknown>;
}

export interface DailyBriefingSnapshot {
  facts: DailyBriefingFact[];
  selectedFacts: DailyBriefingFact[];
  suppressedFacts: DailyBriefingFact[];
  sourceStatus: {
    gmail?: SourceStatus;
    calendar?: SourceStatus;
    asana?: SourceStatus;
  };
  filterRules: DigestFilterRule[];
  links: string[];
  debugSummary: string[];
}

interface SourceStatus {
  ok: boolean;
  loadedCount: number;
  selectedCount: number;
  suppressedCount: number;
  error?: string;
}

const DEFAULT_ASANA_CATEGORY_WEIGHTS: Record<string, number> = {
  school: 28,
  job: 30,
  career: 26,
  admin: 22,
  security: 24,
  billing: 20,
  scanis: 8,
  work: 12,
  content: -4,
  habit: -8,
  personal: 2,
  test: -35,
  duplicate: -25
};

export function buildDailyBriefingSnapshot(input: {
  gmailResult?: ToolExecutionResult | null;
  calendarResult?: ToolExecutionResult | null;
  asanaResult?: ToolExecutionResult | null;
  memoryEntries: PromptMemoryEntry[];
  timezone: string;
  now?: Date;
}): DailyBriefingSnapshot {
  const now = input.now ?? new Date();
  const filterRules = digestFilterRulesFromMemory(input.memoryEntries);
  const priorityProfile = asanaPriorityProfileFromMemory(input.memoryEntries);
  const facts = [
    ...factsFromGmail(input.gmailResult),
    ...factsFromCalendar(input.calendarResult, input.timezone),
    ...factsFromAsana(input.asanaResult, priorityProfile, now)
  ].map((fact) => applyDigestRules(fact, filterRules, "scheduled_digest"));

  const selectedFacts = facts
    .filter((fact) => !fact.filtered)
    .sort((left, right) => right.score - left.score)
    .slice(0, 18);
  const suppressedFacts = facts.filter((fact) => fact.filtered);
  const links = buildCrossSourceLinks(selectedFacts);
  const sourceStatus = {
    gmail: statusForSource("gmail", input.gmailResult, facts, selectedFacts, suppressedFacts),
    calendar: statusForSource(
      "calendar",
      input.calendarResult,
      facts,
      selectedFacts,
      suppressedFacts
    ),
    asana: statusForSource("asana", input.asanaResult, facts, selectedFacts, suppressedFacts)
  };

  return {
    facts,
    selectedFacts,
    suppressedFacts,
    sourceStatus,
    filterRules,
    links,
    debugSummary: formatBriefingDebugSummary(sourceStatus, selectedFacts, suppressedFacts)
  };
}

export function formatDailyBriefingSnapshotForPrompt(snapshot: DailyBriefingSnapshot): string {
  const lines = [
    "Daily briefing intelligence:",
    ...formatSnapshotSourceStatusLines(snapshot),
    ...formatSuppressionLines(snapshot),
    "",
    "Selected calendar facts:",
    ...formatFactLines(
      snapshot.selectedFacts.filter((fact) => fact.source === "calendar"),
      5
    ),
    "",
    "Selected email facts:",
    ...formatFactLines(
      snapshot.selectedFacts.filter((fact) => fact.source === "gmail"),
      6
    ),
    "",
    "Selected Asana facts:",
    ...formatFactLines(
      snapshot.selectedFacts.filter((fact) => fact.source === "asana"),
      8
    ),
    "",
    "Cross-source links:",
    ...(snapshot.links.length ? snapshot.links.map((link) => `- ${link}`) : ["- None detected."]),
    "",
    "Rendering rules:",
    "- Use selected facts as the primary source for the digest.",
    "- Do not mention suppressed facts by name.",
    "- Treat Asana stale due dates as backlog/triage unless the score reasons say urgency or importance.",
    "- Prefer concrete Action items over risk/watchout labels.",
    "- If a fact is low-confidence or merely possibly relevant, say so briefly instead of overstating it."
  ];

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatDailyBriefingDebug(snapshot: DailyBriefingSnapshot): string {
  const selected = snapshot.selectedFacts
    .slice(0, 12)
    .map(
      (fact) => `- ${fact.source}: ${fact.title} (score ${fact.score}; ${fact.reasons.join(", ")})`
    );
  const suppressed = snapshot.suppressedFacts
    .slice(0, 12)
    .map(
      (fact) =>
        `- ${fact.source}: ${fact.title} (${fact.filterReason ?? "suppressed by digest rule"})`
    );

  return [
    "Digest debug",
    "",
    "Loaded/selected/suppressed:",
    ...formatSnapshotSourceStatusLines(snapshot),
    "",
    "Top selected facts:",
    ...(selected.length ? selected : ["- None"]),
    "",
    "Suppressed facts:",
    ...(suppressed.length ? suppressed : ["- None"]),
    "",
    "Active digest rules:",
    ...formatDigestRulesForUser(snapshot.filterRules).split("\n")
  ].join("\n");
}

export function formatDigestRulesForUser(rules: DigestFilterRule[]): string {
  if (!rules.length) return "No digest rules are stored yet.";
  return rules
    .slice(0, 20)
    .map((rule, index) => {
      const target =
        rule.match.calendarName ??
        rule.match.eventTitle ??
        rule.match.emailSubject ??
        rule.match.emailFrom ??
        rule.match.emailCategory ??
        rule.match.asanaProject ??
        rule.match.asanaTag ??
        rule.match.taskNamePattern ??
        rule.match.text ??
        "any matching item";
      return `${index + 1}. ${rule.behavior} ${rule.domain} "${target}" for ${rule.scope}${
        rule.reason ? ` (${rule.reason})` : ""
      }`;
    })
    .join("\n");
}

export function formatLastDigestDebugForUser(
  memoryEntries: PromptMemoryEntry[],
  text: string
): string {
  const entry = memoryEntries.find((item) => item.key === "last_daily_briefing_debug");
  const value = entry?.value;
  if (!value || typeof value !== "object") {
    return "I don't have debug details for the last digest yet. Run the digest again after this update and ask again.";
  }

  const normalized = normalizeText(text);
  const selected = Array.isArray((value as { selectedFacts?: unknown }).selectedFacts)
    ? ((value as { selectedFacts: unknown[] }).selectedFacts as Array<Record<string, unknown>>)
    : [];
  const suppressed = Array.isArray((value as { suppressedFacts?: unknown }).suppressedFacts)
    ? ((value as { suppressedFacts: unknown[] }).suppressedFacts as Array<Record<string, unknown>>)
    : [];
  const target = extractWhyIncludedTarget(normalized);
  const candidates = [...selected, ...suppressed];
  const match = target
    ? candidates.find((fact) => normalizeText(String(fact.title ?? "")).includes(target))
    : candidates[0];

  if (!match) {
    return [
      "I couldn't match that item in the last digest debug record.",
      "Top selected facts were:",
      ...selected
        .slice(0, 5)
        .map((fact) => `• ${String(fact.title ?? "Untitled")} (${String(fact.source ?? "source")})`)
    ].join("\n");
  }

  const reasons = Array.isArray(match.reasons)
    ? match.reasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  const filtered = match.filtered === true;
  return [
    filtered ? "That item was supposed to be suppressed." : "That item was included because:",
    `• Source: ${String(match.source ?? "unknown")}`,
    `• Item: ${String(match.title ?? "Untitled")}`,
    `• Score: ${String(match.score ?? "unknown")}`,
    reasons.length ? `• Reasons: ${reasons.join(", ")}` : null,
    typeof match.filterReason === "string" ? `• Filter: ${match.filterReason}` : null
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function lastDailyBriefingDebugMemoryValue(snapshot: DailyBriefingSnapshot) {
  return {
    createdAt: new Date().toISOString(),
    sourceStatus: snapshot.sourceStatus,
    selectedFacts: snapshot.selectedFacts.slice(0, 30).map(serializeFactForMemory),
    suppressedFacts: snapshot.suppressedFacts.slice(0, 30).map(serializeFactForMemory),
    links: snapshot.links.slice(0, 12)
  };
}

export function digestFilterRulesFromMemory(entries: PromptMemoryEntry[]): DigestFilterRule[] {
  const rules: DigestFilterRule[] = [];

  for (const entry of entries) {
    if (entry.key === "digest_filter_rules") {
      const value = entry.value as { rules?: unknown } | unknown[];
      const rawRules = Array.isArray(value)
        ? value
        : value && typeof value === "object" && Array.isArray((value as { rules?: unknown }).rules)
          ? (value as { rules: unknown[] }).rules
          : [];
      for (const rawRule of rawRules) {
        const rule = normalizeDigestRule(rawRule);
        if (rule) rules.push(rule);
      }
      continue;
    }

    if (entry.key === "calendar_exclusion_preferences") {
      const excluded =
        entry.value &&
        typeof entry.value === "object" &&
        Array.isArray((entry.value as { excludedCalendarNames?: unknown }).excludedCalendarNames)
          ? (entry.value as { excludedCalendarNames: unknown[] }).excludedCalendarNames
          : [];
      for (const name of excluded) {
        if (typeof name !== "string" || !name.trim()) continue;
        rules.push({
          domain: "calendar",
          behavior: "exclude_from_digest",
          scope: "generic_summary",
          match: { calendarName: name, text: name },
          reason: "Stored calendar exclusion"
        });
      }
    }
  }

  return dedupeRules(rules);
}

export function asanaPriorityProfileFromMemory(entries: PromptMemoryEntry[]): AsanaPriorityProfile {
  const profile: AsanaPriorityProfile = {
    categoryWeights: { ...DEFAULT_ASANA_CATEGORY_WEIGHTS },
    projectWeights: {},
    taskPatternWeights: []
  };

  const entry = entries.find((item) => item.key === "asana_priority_profile");
  const value = entry?.value;
  if (!value || typeof value !== "object") return profile;
  const raw = value as AsanaPriorityProfile;
  if (raw.categoryWeights && typeof raw.categoryWeights === "object") {
    profile.categoryWeights = {
      ...profile.categoryWeights,
      ...numberRecord(raw.categoryWeights)
    };
  }
  if (raw.projectWeights && typeof raw.projectWeights === "object") {
    profile.projectWeights = numberRecord(raw.projectWeights);
  }
  if (Array.isArray(raw.taskPatternWeights)) {
    profile.taskPatternWeights = raw.taskPatternWeights.filter(
      (item) => item && typeof item.pattern === "string" && typeof item.weight === "number"
    );
  }
  return profile;
}

function factsFromGmail(result?: ToolExecutionResult | null): DailyBriefingFact[] {
  if (!result?.ok || !Array.isArray(result.data)) return [];
  return (result.data as GmailThreadSummary[]).map((thread, index) =>
    scoreGmailThread(thread, index)
  );
}

function factsFromCalendar(
  result: ToolExecutionResult | null | undefined,
  timezone: string
): DailyBriefingFact[] {
  if (!result?.ok || !Array.isArray(result.data)) return [];
  return (result.data as CalendarEventSummary[]).map((event, index) =>
    scoreCalendarEvent(event, index, timezone)
  );
}

function factsFromAsana(
  result: ToolExecutionResult | null | undefined,
  priorityProfile: AsanaPriorityProfile,
  now: Date
): DailyBriefingFact[] {
  if (!result?.ok || !Array.isArray(result.data)) return [];
  return (result.data as AsanaTaskSummary[]).map((task, index) =>
    scoreAsanaTask(task, index, priorityProfile, now)
  );
}

function scoreGmailThread(thread: GmailThreadSummary, index: number): DailyBriefingFact {
  const subject = thread.subject?.trim() || "(No subject)";
  const from = thread.from?.trim();
  const text = normalizeText([subject, from, thread.snippet].filter(Boolean).join(" "));
  const reasons: string[] = [];
  let score = 30 - index;
  const unread = thread.unread === true;
  if (unread) {
    score += 24;
    reasons.push("unread");
  } else {
    score -= 8;
    reasons.push("read-or-unknown");
  }

  const category = gmailCategory(thread);
  if (category) reasons.push(category);
  if (category === "promotions" || category === "newsletter") score -= 28;
  if (/\b(interview|invite|zoom|meeting|offer|onboarding|action required|deadline)\b/.test(text)) {
    score += 34;
    reasons.push("actionable");
  }
  if (/\b(security|alert|fraud|verification|unauthorized|password|oauth)\b/.test(text)) {
    score += 30;
    reasons.push("security-admin");
  }
  if (/\b(receipt|newsletter|digest|promo|summit|expo|sale|coupon|unsubscribe)\b/.test(text)) {
    score -= 18;
    reasons.push("low-signal-email");
  }

  return {
    id: `gmail:${thread.threadId || index}`,
    source: "gmail",
    title: subject,
    summary: thread.snippet,
    sourceName: from,
    unread,
    category,
    score: clampScore(score),
    reasons: reasons.length ? reasons : ["recent-inbox"],
    provenance: {
      threadId: thread.threadId,
      labelIds: thread.labelIds,
      date: thread.date
    }
  };
}

function scoreCalendarEvent(
  event: CalendarEventSummary,
  index: number,
  timezone: string
): DailyBriefingFact {
  const title = event.title || "(Untitled)";
  const allDay = isAllDayEvent(event);
  const taskLike = allDay && /\b(task|test|router|due|todo|asana)\b/i.test(title);
  const reasons: string[] = [];
  let score = allDay ? 22 : 62;
  if (allDay) reasons.push("all-day");
  else reasons.push("timed-event");
  if (/\b(final|exam|interview|meeting|appointment|appt|call)\b/i.test(title)) {
    score += 25;
    reasons.push("hard-commitment");
  }
  if (taskLike) {
    score -= 35;
    reasons.push("all-day-task-like");
  }
  if (index < 3) score += 4 - index;

  const fact: DailyBriefingFact = {
    id: `calendar:${event.calendarId ?? "calendar"}:${event.id ?? index}`,
    source: "calendar",
    title,
    sourceName: event.calendarSummary ?? event.calendarId,
    start: event.start,
    end: event.end,
    score: clampScore(score),
    reasons,
    provenance: {
      eventId: event.id,
      calendarId: event.calendarId,
      calendarSummary: event.calendarSummary,
      startLabel: event.start ? formatDateTimeForPrompt(event.start, timezone) : undefined,
      endLabel: event.end ? formatDateTimeForPrompt(event.end, timezone) : undefined
    }
  };
  if (taskLike) {
    fact.filtered = true;
    fact.filterReason = "Suppressed all-day task-like calendar item from digest schedule.";
  }
  return fact;
}

function scoreAsanaTask(
  task: AsanaTaskSummary,
  index: number,
  priorityProfile: AsanaPriorityProfile,
  now: Date
): DailyBriefingFact {
  const projectName = task.projects?.[0]?.name;
  const text = normalizeText([task.name, projectName, task.notes].filter(Boolean).join(" "));
  const category = asanaCategory(task);
  const reasons = [category ? `${category}-task` : "task"];
  let score = 24 - Math.min(index, 20);
  const dueAge = asanaDueAgeDays(task.dueOn, now);

  if (dueAge !== null) {
    if (dueAge === 0) {
      score += 36;
      reasons.push("due-today");
    } else if (dueAge > 0 && dueAge <= 7) {
      score += 24;
      reasons.push("recently-overdue");
    } else if (dueAge > 7) {
      score -= 10;
      reasons.push("stale-overdue");
    } else if (dueAge < 0 && dueAge >= -7) {
      score += 12;
      reasons.push("due-soon");
    }
  } else {
    score -= 8;
    reasons.push("no-due-date");
  }

  const categoryWeight = category ? (priorityProfile.categoryWeights?.[category] ?? 0) : 0;
  if (categoryWeight) {
    score += categoryWeight;
    reasons.push(`priority:${categoryWeight > 0 ? "+" : ""}${categoryWeight}`);
  }
  const projectWeight = projectName
    ? (priorityProfile.projectWeights?.[normalizeText(projectName)] ?? 0)
    : 0;
  if (projectWeight) {
    score += projectWeight;
    reasons.push(`project-priority:${projectWeight > 0 ? "+" : ""}${projectWeight}`);
  }
  for (const rule of priorityProfile.taskPatternWeights ?? []) {
    if (normalizeText(text).includes(normalizeText(rule.pattern))) {
      score += rule.weight;
      reasons.push(rule.reason ?? `task-priority:${rule.weight}`);
    }
  }
  if (/\b(test|router test|no due project test|duplicate)\b/.test(text)) {
    score -= 35;
    reasons.push("test-or-duplicate");
  }
  if (
    /\b(interview|offer|onboarding|healthcare|benefit|account|security|final|exam)\b/.test(text)
  ) {
    score += 18;
    reasons.push("life-admin-or-deadline");
  }

  return {
    id: `asana:${task.gid || index}`,
    source: "asana",
    title: task.name,
    projectName,
    dueOn: task.dueOn,
    score: clampScore(score),
    reasons,
    provenance: {
      taskGid: task.gid,
      projects: task.projects,
      completed: task.completed,
      permalinkUrl: task.permalinkUrl
    }
  };
}

function applyDigestRules(
  fact: DailyBriefingFact,
  rules: DigestFilterRule[],
  scope: DigestFilterScope
): DailyBriefingFact {
  let next = { ...fact, reasons: [...fact.reasons] };
  for (const rule of rules) {
    if (!digestRuleAppliesToFact(rule, next, scope)) continue;
    if (rule.behavior === "exclude_from_digest" || rule.behavior === "include_only_on_direct_ask") {
      next = {
        ...next,
        filtered: true,
        filterReason: rule.reason ?? `${rule.domain} matched a digest filter rule`
      };
      continue;
    }
    if (rule.behavior === "downrank") {
      next.score = clampScore(next.score - 30);
      next.reasons.push(rule.reason ?? "downranked-by-preference");
    } else if (rule.behavior === "always_include") {
      next.score = clampScore(next.score + 35);
      next.reasons.push(rule.reason ?? "boosted-by-preference");
    }
  }
  return next;
}

function digestRuleAppliesToFact(
  rule: DigestFilterRule,
  fact: DailyBriefingFact,
  scope: DigestFilterScope
): boolean {
  if (rule.domain !== "all" && rule.domain !== fact.source) return false;
  if (!scopeMatches(rule.scope, scope)) return false;

  const haystack = normalizeText(
    [
      fact.title,
      fact.summary,
      fact.sourceName,
      fact.category,
      fact.projectName,
      fact.reasons.join(" ")
    ]
      .filter(Boolean)
      .join(" ")
  );
  const matchers = [
    rule.match.text,
    fact.source === "calendar" ? rule.match.calendarName : undefined,
    fact.source === "calendar" ? rule.match.eventTitle : undefined,
    fact.source === "gmail" ? rule.match.emailSubject : undefined,
    fact.source === "gmail" ? rule.match.emailFrom : undefined,
    fact.source === "gmail" ? rule.match.emailCategory : undefined,
    fact.source === "asana" ? rule.match.asanaProject : undefined,
    fact.source === "asana" ? rule.match.asanaTag : undefined,
    fact.source === "asana" ? rule.match.taskNamePattern : undefined
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));

  return matchers.some((matcher) => haystack.includes(normalizeText(matcher)));
}

function scopeMatches(ruleScope: DigestFilterScope, currentScope: DigestFilterScope): boolean {
  if (ruleScope === "all_reads") return true;
  if (currentScope === "scheduled_digest") {
    return ruleScope === "scheduled_digest" || ruleScope === "generic_summary";
  }
  return ruleScope === currentScope;
}

function statusForSource(
  source: DailyBriefingFact["source"],
  result: ToolExecutionResult | null | undefined,
  facts: DailyBriefingFact[],
  selectedFacts: DailyBriefingFact[],
  suppressedFacts: DailyBriefingFact[]
): SourceStatus | undefined {
  if (!result) return undefined;
  return {
    ok: result.ok,
    loadedCount: facts.filter((fact) => fact.source === source).length,
    selectedCount: selectedFacts.filter((fact) => fact.source === source).length,
    suppressedCount: suppressedFacts.filter((fact) => fact.source === source).length,
    ...(!result.ok ? { error: result.userMessage ?? result.error ?? "Unavailable" } : {})
  };
}

function formatSnapshotSourceStatusLines(snapshot: DailyBriefingSnapshot): string[] {
  return formatSourceStatusLines(snapshot.sourceStatus);
}

function formatSourceStatusLines(status: DailyBriefingSnapshot["sourceStatus"]): string[] {
  return (["gmail", "calendar", "asana"] as const)
    .map((source) => {
      const item = status[source];
      if (!item) return null;
      if (!item.ok) return `- ${source}: unavailable (${item.error ?? "read failed"})`;
      return `- ${source}: loaded ${item.loadedCount}, selected ${item.selectedCount}, suppressed ${item.suppressedCount}`;
    })
    .filter((line): line is string => Boolean(line));
}

function formatSuppressionLines(snapshot: DailyBriefingSnapshot): string[] {
  const suppressedBySource = new Map<string, number>();
  for (const fact of snapshot.suppressedFacts) {
    suppressedBySource.set(fact.source, (suppressedBySource.get(fact.source) ?? 0) + 1);
  }
  if (!suppressedBySource.size) return ["Filters applied: none."];
  return [
    `Filters applied: ${Array.from(suppressedBySource.entries())
      .map(([source, count]) => `${count} ${source}`)
      .join(", ")} suppressed.`
  ];
}

function formatFactLines(facts: DailyBriefingFact[], limit: number): string[] {
  if (!facts.length) return ["- None selected."];
  return facts.slice(0, limit).map((fact) => {
    const details = [
      fact.sourceName,
      fact.projectName,
      fact.dueOn ? `due ${fact.dueOn}` : undefined,
      fact.start ? `starts ${String(fact.provenance.startLabel ?? fact.start)}` : undefined,
      fact.unread ? "unread" : undefined
    ]
      .filter(Boolean)
      .join(" • ");
    return `- [score ${fact.score}; ${fact.reasons.slice(0, 4).join(", ")}] ${fact.title}${
      details ? ` (${details})` : ""
    }${fact.summary ? `: ${truncate(fact.summary, 180)}` : ""}`;
  });
}

function formatBriefingDebugSummary(
  sourceStatus: DailyBriefingSnapshot["sourceStatus"],
  selectedFacts: DailyBriefingFact[],
  suppressedFacts: DailyBriefingFact[]
): string[] {
  return [
    ...formatSourceStatusLines(sourceStatus),
    `Top facts: ${selectedFacts
      .slice(0, 5)
      .map((fact) => `${fact.source}:${fact.title}`)
      .join("; ")}`,
    `Suppressed count: ${suppressedFacts.length}`
  ];
}

function buildCrossSourceLinks(facts: DailyBriefingFact[]): string[] {
  const links: string[] = [];
  const emailFacts = facts.filter((fact) => fact.source === "gmail");
  const calendarFacts = facts.filter((fact) => fact.source === "calendar");
  const asanaFacts = facts.filter((fact) => fact.source === "asana");

  for (const email of emailFacts) {
    const emailTokens = importantTokens(email.title);
    for (const calendar of calendarFacts) {
      if (sharesImportantToken(emailTokens, importantTokens(calendar.title))) {
        links.push(
          `Email "${email.title}" appears related to calendar event "${calendar.title}"; merge them into one action if useful.`
        );
      }
    }
    for (const task of asanaFacts) {
      if (sharesImportantToken(emailTokens, importantTokens(task.title))) {
        links.push(
          `Email "${email.title}" may connect to Asana task "${task.title}"; mention the combined next step only if it is actionable.`
        );
      }
    }
  }

  return Array.from(new Set(links)).slice(0, 5);
}

function gmailCategory(thread: GmailThreadSummary): string | undefined {
  const labels = (thread.labelIds ?? []).map((label) => label.toLowerCase());
  if (labels.some((label) => label.includes("category_promotions"))) return "promotions";
  if (labels.some((label) => label.includes("category_updates"))) return "updates";
  if (labels.some((label) => label.includes("category_social"))) return "social";
  const text = normalizeText([thread.subject, thread.from].filter(Boolean).join(" "));
  if (/\b(newsletter|digest|weekly|substack|product hunt|aicamp|cohley)\b/.test(text)) {
    return "newsletter";
  }
  return undefined;
}

function asanaCategory(task: AsanaTaskSummary): string | undefined {
  const projectName = normalizeText(task.projects?.[0]?.name ?? "");
  const text = normalizeText([task.name, projectName, task.notes].filter(Boolean).join(" "));
  if (/\b(test|router test|no due project test|duplicate)\b/.test(text)) return "test";
  if (/\b(school|class|exam|homework|hw|systems|phys|cs )\b/.test(text)) return "school";
  if (/\b(job|interview|offer|career|treasury|onboarding)\b/.test(text)) return "job";
  if (
    /\b(cancel|account|healthcare|benefit|chase|rent|ticket|verizon|billing|refund)\b/.test(text)
  ) {
    return "admin";
  }
  if (/\b(scanis|scandash)\b/.test(text)) return "scanis";
  if (/\b(content|post|story|video|film|linkedin)\b/.test(text)) return "content";
  if (/\b(workout|meditate|gym|personal growth)\b/.test(text)) return "habit";
  return projectName || undefined;
}

function asanaDueAgeDays(dueOn: string | undefined, now: Date): number | null {
  if (!dueOn) return null;
  const due = Date.parse(`${dueOn}T00:00:00.000Z`);
  if (Number.isNaN(due)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - due) / 86_400_000);
}

function isAllDayEvent(event: CalendarEventSummary): boolean {
  return Boolean(event.start && /^\d{4}-\d{2}-\d{2}$/.test(event.start));
}

function normalizeDigestRule(rawRule: unknown): DigestFilterRule | null {
  if (!rawRule || typeof rawRule !== "object") return null;
  const value = rawRule as Partial<DigestFilterRule>;
  if (!value.domain || !value.behavior || !value.scope || !value.match) return null;
  if (!["calendar", "gmail", "asana", "all"].includes(value.domain)) return null;
  if (
    !["exclude_from_digest", "include_only_on_direct_ask", "downrank", "always_include"].includes(
      value.behavior
    )
  ) {
    return null;
  }
  if (!["scheduled_digest", "generic_summary", "all_reads"].includes(value.scope)) return null;
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    domain: value.domain,
    behavior: value.behavior,
    scope: value.scope,
    match: value.match,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    source: typeof value.source === "string" ? value.source : undefined,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined
  };
}

function dedupeRules(rules: DigestFilterRule[]): DigestFilterRule[] {
  const map = new Map<string, DigestFilterRule>();
  for (const rule of rules) {
    const key = JSON.stringify({
      domain: rule.domain,
      behavior: rule.behavior,
      scope: rule.scope,
      match: rule.match
    });
    map.set(key, rule);
  }
  return Array.from(map.values());
}

function serializeFactForMemory(fact: DailyBriefingFact) {
  return {
    source: fact.source,
    title: fact.title,
    score: fact.score,
    reasons: fact.reasons.slice(0, 8),
    filtered: fact.filtered === true,
    filterReason: fact.filterReason,
    sourceName: fact.sourceName,
    projectName: fact.projectName,
    dueOn: fact.dueOn,
    start: fact.start
  };
}

function numberRecord(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number")
      .map(([key, numberValue]) => [normalizeText(key), numberValue])
  );
}

function importantTokens(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .filter(
      (token) =>
        ![
          "from",
          "with",
          "your",
          "about",
          "today",
          "tomorrow",
          "update",
          "meeting",
          "email",
          "task"
        ].includes(token)
    )
    .slice(0, 10);
}

function sharesImportantToken(left: string[], right: string[]): boolean {
  if (!left.length || !right.length) return false;
  const rightSet = new Set(right);
  return left.some((token) => rightSet.has(token));
}

function extractWhyIncludedTarget(normalized: string): string | null {
  const match = normalized.match(/\b(?:include|mention|show|surface)\s+(?:this|that|the)?\s*(.+)$/);
  const target = match?.[1]?.trim();
  return target && target.length > 2 ? target : null;
}

function formatDateTimeForPrompt(value: string, timezone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  }).format(date);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}...`;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9@.'+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
