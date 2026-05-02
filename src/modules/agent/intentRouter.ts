import type { ResponseInputItem } from "../../lib/openaiClient";
import { parseConfirmationIntent } from "./approvalPolicy";
import type { PromptMemoryEntry } from "./conversationContext";
import {
  matchAmbiguousAsanaBulkCompleteRequest,
  matchAsanaBulkRetryRequest,
  matchAsanaDueTodayAndLatestOpenRequest,
  matchAsanaLatestTaskShortcut,
  matchAsanaListShortcut,
  matchAsanaProjectsRequest,
  matchGenericAsanaOpenTasksRequest,
  matchGenericAsanaMyTasksRequest,
  matchListedAsanaBulkCompleteRequest
} from "./asanaReadShortcut";
import {
  matchCalendarAllCalendarsFollowUpRequest,
  matchGenericCalendarOverviewRequest
} from "./calendarReadShortcut";

export type IntentDomain =
  | "asana"
  | "automation"
  | "calendar"
  | "gmail"
  | "docs"
  | "drive"
  | "notion"
  | "web"
  | "setup"
  | "general";

export type PrimaryIntentDomain = IntentDomain | "multi";

export type IntentAction =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "draft"
  | "send"
  | "confirm"
  | "cancel"
  | "setup"
  | "retry"
  | "run_once"
  | "unknown";

export type IntentConfidence = "high" | "medium" | "low";

export type RequiredIntegration = "google" | "asana" | "notion";

export type IntentShortcutCandidate =
  | "one_time_morning_digest"
  | "missing_digest_retry"
  | "ambiguous_asana_bulk_complete"
  | "recent_google_doc_delete"
  | "calendar_overview"
  | "asana_listed_bulk_complete"
  | "asana_bulk_retry"
  | "asana_projects"
  | "asana_today_and_latest_open"
  | "asana_latest_task"
  | "asana_list"
  | "asana_project_tasks"
  | "asana_open_tasks"
  | "asana_my_tasks";

export interface IntentEntity {
  type: string;
  value: string;
}

export interface IntentRoute {
  domains: IntentDomain[];
  primaryDomain: PrimaryIntentDomain;
  action: IntentAction;
  confidence: IntentConfidence;
  isCompound: boolean;
  requiredIntegrations: RequiredIntegration[];
  shortcutCandidate?: IntentShortcutCandidate;
  fallbackReason: string;
  entities: IntentEntity[];
  trace: string[];
}

export interface RoutingContext {
  text: string;
  hasModelInput?: boolean;
  history?: ResponseInputItem[];
  memoryEntries?: PromptMemoryEntry[];
  timezone?: string;
  hasPendingAction?: boolean;
  pendingActionSummary?: string;
}

interface DomainHit {
  domain: IntentDomain;
  confidence: Exclude<IntentConfidence, "low">;
  reason: string;
}

const DOMAIN_ORDER: IntentDomain[] = [
  "setup",
  "automation",
  "web",
  "calendar",
  "gmail",
  "drive",
  "docs",
  "notion",
  "asana",
  "general"
];

const ACTION_PATTERNS = [
  /\bshow\b/g,
  /\bcheck\b/g,
  /\blist\b/g,
  /\bread\b/g,
  /\bsearch\b/g,
  /\blook\s+up\b/g,
  /\bfind\b/g,
  /\bcreate\b/g,
  /\bmake\b/g,
  /\badd\b/g,
  /\bput\b/g,
  /\bschedule\b/g,
  /\bbook\b/g,
  /\bdraft\b/g,
  /\bsend\b/g,
  /\bdelete\b/g,
  /\bremove\b/g,
  /\btrash\b/g,
  /\bappend\b/g,
  /\bupdate\b/g,
  /\bmove\b/g,
  /\breschedule\b/g,
  /\bcancel\b/g,
  /\bcomplete\b/g,
  /\bmark\b/g
];

export function classifyIntentRoute(input: RoutingContext): IntentRoute {
  const text = input.text.trim();
  const normalized = normalize(text);
  const history = input.history ?? [];
  const memoryEntries = input.memoryEntries ?? [];
  const timezone = input.timezone ?? "America/New_York";
  const trace: string[] = [];
  const entities: IntentEntity[] = [];

  let domainHits = detectDomainHits(text, normalized, trace);
  let shortcutCandidate = input.hasModelInput
    ? undefined
    : detectShortcutCandidate(text, normalized, history, memoryEntries, timezone, entities, trace);

  domainHits = applyShortcutDomainHints(domainHits, shortcutCandidate, trace);
  const domains = orderedDomains(domainHits);
  const isCompound = computeCompound(domains, normalized);
  const primaryDomain = domains.length > 1 ? "multi" : (domains[0] ?? "general");
  const action = detectAction({
    normalized,
    primaryDomain,
    domains,
    shortcutCandidate,
    hasPendingAction: Boolean(input.hasPendingAction),
    trace
  });
  const confidence = detectConfidence({
    action,
    domainHits,
    shortcutCandidate,
    isCompound,
    hasModelInput: Boolean(input.hasModelInput),
    trace
  });

  if (isCompound && shortcutCandidate && !compoundSafeShortcut(shortcutCandidate)) {
    trace.push(`shortcut_suppressed_for_compound:${shortcutCandidate}`);
    shortcutCandidate = undefined;
  }

  const effectiveDomains: IntentDomain[] = domains.length ? domains : ["general"];
  return {
    domains: effectiveDomains,
    primaryDomain: effectiveDomains.length > 1 ? "multi" : (effectiveDomains[0] ?? "general"),
    action,
    confidence,
    isCompound,
    requiredIntegrations: requiredIntegrationsForRoute(effectiveDomains, action, confidence),
    shortcutCandidate,
    fallbackReason: fallbackReasonForRoute({
      hasModelInput: Boolean(input.hasModelInput),
      isCompound,
      shortcutCandidate,
      confidence,
      action,
      domains: effectiveDomains
    }),
    entities,
    trace
  };
}

export function summarizeIntentRouteForLog(route: IntentRoute): Record<string, unknown> {
  return {
    domains: route.domains,
    primaryDomain: route.primaryDomain,
    action: route.action,
    confidence: route.confidence,
    isCompound: route.isCompound,
    requiredIntegrations: route.requiredIntegrations,
    shortcutCandidate: route.shortcutCandidate,
    fallbackReason: route.fallbackReason,
    entityTypes: route.entities.map((entity) => entity.type),
    trace: route.trace
  };
}

export function formatIntentRouteForPrompt(route: IntentRoute): string {
  const entities = route.entities.length
    ? route.entities.map((entity) => `${entity.type}: ${entity.value}`).join(", ")
    : "None";
  return [
    `Intent route: ${route.primaryDomain}/${route.action}/${route.confidence}`,
    `Domains: ${route.domains.join(", ")}`,
    `Compound: ${route.isCompound ? "yes" : "no"}`,
    `Entities: ${entities}`,
    route.shortcutCandidate ? `Backend shortcut: ${route.shortcutCandidate}` : undefined,
    `Model fallback reason: ${route.fallbackReason}`
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function detectDomainHits(text: string, normalized: string, trace: string[]): DomainHit[] {
  const hits: DomainHit[] = [];
  const add = (
    domain: IntentDomain,
    confidence: Exclude<IntentConfidence, "low">,
    reason: string
  ) => {
    if (hits.some((hit) => hit.domain === domain)) return;
    hits.push({ domain, confidence, reason });
    trace.push(`${domain}:${confidence}:${reason}`);
  };

  if (referencesSetup(normalized)) add("setup", "high", "setup_request");
  if (referencesAutomation(normalized)) add("automation", "high", "automation_signal");
  if (referencesWeb(text, normalized)) add("web", "high", "web_or_market_signal");
  if (referencesCalendarStrong(normalized)) add("calendar", "high", "explicit_calendar");
  else if (referencesCalendarMedium(normalized))
    add("calendar", "medium", "calendar_action_object");
  if (referencesGmailStrong(normalized)) add("gmail", "high", "explicit_gmail_or_email");
  else if (referencesGmailMedium(normalized)) add("gmail", "medium", "email_action");
  if (referencesDriveStrong(normalized)) add("drive", "high", "explicit_drive");
  else if (referencesDriveMedium(normalized)) add("drive", "medium", "drive_file_action");
  if (referencesDocsStrong(normalized)) add("docs", "high", "explicit_docs");
  if (referencesNotion(normalized)) add("notion", "high", "explicit_notion");
  if (referencesAsanaStrong(normalized)) add("asana", "high", "explicit_asana");
  else if (referencesAsanaMedium(normalized)) add("asana", "medium", "task_action");

  return hits;
}

function detectShortcutCandidate(
  text: string,
  normalized: string,
  history: ResponseInputItem[],
  memoryEntries: PromptMemoryEntry[],
  timezone: string,
  entities: IntentEntity[],
  trace: string[]
): IntentShortcutCandidate | undefined {
  if (matchesOneTimeMorningDigest(text, history)) {
    trace.push("shortcut:one_time_morning_digest");
    return "one_time_morning_digest";
  }
  if (matchesMissingDigestRetry(text, history)) {
    trace.push("shortcut:missing_digest_retry");
    return "missing_digest_retry";
  }
  if (matchAsanaBulkRetryRequest(text, memoryEntries)) {
    trace.push("shortcut:asana_bulk_retry");
    return "asana_bulk_retry";
  }
  if (matchListedAsanaBulkCompleteRequest(text)) {
    trace.push("shortcut:asana_listed_bulk_complete");
    return "asana_listed_bulk_complete";
  }
  if (matchAmbiguousAsanaBulkCompleteRequest(text, memoryEntries)) {
    trace.push("shortcut:ambiguous_asana_bulk_complete");
    return "ambiguous_asana_bulk_complete";
  }
  if (matchesRecentGoogleDocDelete(text, memoryEntries)) {
    trace.push("shortcut:recent_google_doc_delete");
    return "recent_google_doc_delete";
  }
  if (
    matchGenericCalendarOverviewRequest(text) ??
    matchCalendarAllCalendarsFollowUpRequest(text, history)
  ) {
    trace.push("shortcut:calendar_overview");
    return "calendar_overview";
  }
  if (matchAsanaDueTodayAndLatestOpenRequest(text, history, memoryEntries, timezone)) {
    trace.push("shortcut:asana_today_and_latest_open");
    return "asana_today_and_latest_open";
  }
  if (matchAsanaLatestTaskShortcut(text, history, memoryEntries)) {
    trace.push("shortcut:asana_latest_task");
    return "asana_latest_task";
  }
  if (matchAsanaListShortcut(text, history, memoryEntries, timezone)) {
    trace.push("shortcut:asana_list");
    return "asana_list";
  }
  if (matchAsanaProjectsRequest(text)) {
    trace.push("shortcut:asana_projects");
    return "asana_projects";
  }

  const projectName = extractAsanaProjectTaskName(text);
  if (projectName) {
    entities.push({ type: "asana_project_name", value: projectName });
    trace.push("shortcut:asana_project_tasks");
    return "asana_project_tasks";
  }

  if (matchGenericAsanaOpenTasksRequest(text)) {
    trace.push("shortcut:asana_open_tasks");
    return "asana_open_tasks";
  }
  if (matchGenericAsanaMyTasksRequest(text)) {
    trace.push("shortcut:asana_my_tasks");
    return "asana_my_tasks";
  }

  return undefined;
}

function applyShortcutDomainHints(
  domainHits: DomainHit[],
  shortcut: IntentShortcutCandidate | undefined,
  trace: string[]
): DomainHit[] {
  const hits = [...domainHits];
  const ensure = (
    domain: IntentDomain,
    confidence: Exclude<IntentConfidence, "low">,
    reason: string
  ) => {
    if (hits.some((hit) => hit.domain === domain)) return;
    hits.push({ domain, confidence, reason });
    trace.push(`${domain}:${confidence}:${reason}`);
  };

  if (!shortcut) return hits;
  if (shortcut === "calendar_overview") ensure("calendar", "high", "calendar_shortcut");
  if (
    shortcut === "asana_today_and_latest_open" ||
    shortcut === "asana_latest_task" ||
    shortcut === "asana_list" ||
    shortcut === "asana_listed_bulk_complete" ||
    shortcut === "asana_bulk_retry" ||
    shortcut === "asana_projects" ||
    shortcut === "asana_project_tasks" ||
    shortcut === "asana_open_tasks" ||
    shortcut === "asana_my_tasks" ||
    shortcut === "ambiguous_asana_bulk_complete"
  ) {
    ensure("asana", "high", "asana_shortcut");
  }
  if (shortcut === "recent_google_doc_delete") ensure("docs", "high", "recent_doc_shortcut");
  if (shortcut === "one_time_morning_digest" || shortcut === "missing_digest_retry") {
    ensure("automation", "high", "digest_shortcut");
  }
  return hits;
}

function orderedDomains(hits: DomainHit[]): IntentDomain[] {
  const present = new Set(hits.map((hit) => hit.domain));
  return DOMAIN_ORDER.filter((domain) => present.has(domain));
}

function detectAction(input: {
  normalized: string;
  primaryDomain: PrimaryIntentDomain;
  domains: IntentDomain[];
  shortcutCandidate?: IntentShortcutCandidate;
  hasPendingAction: boolean;
  trace: string[];
}): IntentAction {
  const confirmation = parseConfirmationIntent(input.normalized);
  if (confirmation && input.hasPendingAction) {
    input.trace.push(`action:${confirmation.toLowerCase()}_pending`);
    if (confirmation === "CANCEL") return "cancel";
    if (confirmation === "SEND") return "send";
    return "confirm";
  }
  if (confirmation === "CANCEL" && isShortCancel(input.normalized)) {
    input.trace.push("action:cancel_no_pending");
    return "cancel";
  }
  if (confirmation && isShortPendingReference(input.normalized)) {
    input.trace.push("action:pending_reference_without_pending");
    return "unknown";
  }
  if (input.shortcutCandidate === "one_time_morning_digest") return "run_once";
  if (input.shortcutCandidate === "missing_digest_retry") return "retry";
  if (
    input.shortcutCandidate === "ambiguous_asana_bulk_complete" ||
    input.shortcutCandidate === "asana_listed_bulk_complete" ||
    input.shortcutCandidate === "asana_bulk_retry"
  ) {
    return "update";
  }
  if (input.shortcutCandidate === "recent_google_doc_delete") return "delete";
  if (input.shortcutCandidate) return "read";
  if (input.domains.includes("setup")) return "setup";
  if (input.domains.includes("gmail") && /\b(send|draft|write|compose)\b/.test(input.normalized)) {
    return "draft";
  }
  if (isWeakScheduleStatement(input.normalized)) {
    input.trace.push("action:weak_schedule_statement");
    return "unknown";
  }
  if (/\b(delete|trash|remove|get rid of|cancel)\b/.test(input.normalized)) return "delete";
  if (/\b(append|update|move|reschedule|rename|complete|mark)\b/.test(input.normalized)) {
    return "update";
  }
  if (/\b(create|make|add|put|schedule|book|set)\b/.test(input.normalized)) return "create";
  if (
    /\b(show|check|list|read|search|look up|find|what|why|summarize|inspect)\b/.test(
      input.normalized
    )
  ) {
    return "read";
  }
  return "unknown";
}

function detectConfidence(input: {
  action: IntentAction;
  domainHits: DomainHit[];
  shortcutCandidate?: IntentShortcutCandidate;
  isCompound: boolean;
  hasModelInput: boolean;
  trace: string[];
}): IntentConfidence {
  if (input.shortcutCandidate) return "high";
  if (input.hasModelInput) return "medium";
  if (input.domainHits.some((hit) => hit.confidence === "high") && input.action !== "unknown") {
    return "high";
  }
  if (input.domainHits.length && input.action !== "unknown") return "medium";
  if (input.isCompound && input.domainHits.length) return "medium";
  return "low";
}

function requiredIntegrationsForRoute(
  domains: IntentDomain[],
  action: IntentAction,
  confidence: IntentConfidence
): RequiredIntegration[] {
  if (confidence === "low" || action === "setup" || domains.includes("setup")) return [];
  const required = new Set<RequiredIntegration>();
  for (const domain of domains) {
    if (domain === "calendar" || domain === "gmail" || domain === "drive" || domain === "docs") {
      required.add("google");
    }
    if (domain === "asana") required.add("asana");
    if (domain === "notion") required.add("notion");
  }
  return Array.from(required);
}

function fallbackReasonForRoute(input: {
  hasModelInput: boolean;
  isCompound: boolean;
  shortcutCandidate?: IntentShortcutCandidate;
  confidence: IntentConfidence;
  action: IntentAction;
  domains: IntentDomain[];
}): string {
  if (input.shortcutCandidate) return "deterministic_shortcut";
  if (input.hasModelInput) return "model_input";
  if (input.isCompound) return "compound_model_loop";
  if (input.confidence === "low") return "low_confidence_model_loop";
  if (input.action === "unknown") return "unknown_action_model_loop";
  return "model_tool_loop";
}

function computeCompound(domains: IntentDomain[], normalized: string): boolean {
  const actionableDomains = domains.filter((domain) => domain !== "setup" && domain !== "general");
  if (actionableDomains.length > 1) return true;
  if (!/\b(?:and|then|also|plus)\b|[;,]/.test(normalized)) return false;
  return countActionMentions(normalized) >= 2;
}

function compoundSafeShortcut(shortcut: IntentShortcutCandidate): boolean {
  return shortcut === "missing_digest_retry";
}

function referencesSetup(normalized: string): boolean {
  const setupText = stripNamedObjectText(normalized);
  return (
    /^(setup|set up|connect|connections|integrations|status)$/.test(setupText) ||
    /^(?:show|check|view) (?:my )?(?:setup|connections|integrations|connected accounts|account status)$/.test(
      setupText
    ) ||
    /^what(?:'s| is) connected$/.test(setupText) ||
    /^which (?:accounts|integrations) (?:are )?connected$/.test(setupText) ||
    /^help (?:me )?(?:setting|set) up$/.test(setupText) ||
    /^(?:connect|reconnect) (?:my )?(?:accounts|integrations|google|asana|notion)$/.test(
      setupText
    ) ||
    /^(?:connect|reconnect) (?:my )?.*\b(?:google|asana|notion|accounts|integrations)\b/.test(
      setupText
    ) ||
    /\b(?:google|gmail|calendar|drive|docs?|asana|notion)\b.*\b(link|url|auth|oauth|connect|reconnect|login|sign in|page picker|select pages?)\b/.test(
      setupText
    ) ||
    /\b(link|url|auth|oauth|connect|reconnect|login|sign in|page picker|select pages?)\b.*\b(?:google|gmail|calendar|drive|docs?|asana|notion)\b/.test(
      setupText
    )
  );
}

function stripNamedObjectText(normalized: string): string {
  return normalized.replace(/\b(?:called|named|titled)\b.*$/i, "").trim();
}

function referencesAutomation(normalized: string): boolean {
  return (
    /\b(automation|automations|recurring|scheduled digest|daily digest|weekly digest)\b/.test(
      normalized
    ) ||
    /\bevery (?:morning|afternoon|evening|day|weekday|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(
      normalized
    ) ||
    /\b(pause|resume|delete|list|show)\b.*\bautomations?\b/.test(normalized)
  );
}

function referencesWeb(original: string, normalized: string): boolean {
  return (
    /\b(look up|online|web|internet)\b/.test(normalized) ||
    /\bsearch\b.*\b(web|internet|online)\b/.test(normalized) ||
    /\bgoogle (?:it|this|that)\b/.test(normalized) ||
    /\b(stock|stocks|share|shares|market|earnings|ticker)\b/.test(normalized) ||
    (/\b[A-Z]{2,5}\b/.test(original) &&
      /\b(why|up|down|news|today|price|move|moving|doing)\b/.test(normalized))
  );
}

function referencesCalendarStrong(normalized: string): boolean {
  return (
    /\bmy\s+(?:cal|calendar)\b/.test(normalized) ||
    /\ball (?:my )?calendars?\b/.test(normalized) ||
    /\bcalendar\b/.test(normalized) ||
    /\b(cal)\b/.test(normalized)
  );
}

function referencesCalendarMedium(normalized: string): boolean {
  return (
    /\b(add|put|create|schedule|book|set|move|reschedule|cancel)\b[^.?!]*(?:event|meeting|appointment|reminder)\b/.test(
      normalized
    ) ||
    /\b(?:event|meeting|appointment|reminder)\b[^.?!]*\b(add|put|create|schedule|book|set|move|reschedule|cancel)\b/.test(
      normalized
    )
  );
}

function referencesGmailStrong(normalized: string): boolean {
  return /\b(gmail|email|e-mail|inbox|email thread|mail thread)\b/.test(normalized);
}

function referencesGmailMedium(normalized: string): boolean {
  return /\b(send|draft|write|compose)\b[^.?!]*\bmail\b/.test(normalized);
}

function referencesDriveStrong(normalized: string): boolean {
  return /\b(google drive|drive file|drive folder)\b/.test(normalized);
}

function referencesDriveMedium(normalized: string): boolean {
  return (
    /\b(search|find|open|delete|trash|read)\b[^.?!]*\b(file|folder)\b/.test(normalized) ||
    /\b(file|folder)\b[^.?!]*\b(search|find|open|delete|trash|read)\b/.test(normalized)
  );
}

function referencesDocsStrong(normalized: string): boolean {
  return /\b(google doc|docs|document)\b/.test(normalized) || /\bdoc\b/.test(normalized);
}

function referencesNotion(normalized: string): boolean {
  return /\b(notion|notion page|notion doc|workspace page)\b/.test(normalized);
}

function referencesAsanaStrong(normalized: string): boolean {
  return (
    /\basana\b/.test(normalized) ||
    /\bmy tasks\b/.test(normalized) ||
    /\basana tasks?\b/.test(normalized) ||
    /\bproject tasks?\b/.test(normalized) ||
    /\bdue tasks?\b/.test(normalized) ||
    /\b(show|list|check)\b[^.?!]*\btasks?\s+in\s+[a-z0-9 _-]+\b/.test(normalized)
  );
}

function referencesAsanaMedium(normalized: string): boolean {
  return (
    /\b(show|list|check|complete|mark|create|add|update|delete)\b[^.?!]*\btasks?\b/.test(
      normalized
    ) || /\btasks?\b[^.?!]*\b(due|overdue|complete|completed|incomplete)\b/.test(normalized)
  );
}

function matchesOneTimeMorningDigest(text: string, history: ResponseInputItem[]): boolean {
  const normalized = normalize(text);
  const directRun =
    /\b(run|do|trigger|start)\b.*\b(?:8\s*am|morning|daily)?\s*(?:automation|digest)\b.*\b(now|manual|manually|one[ -]?time|exception)\b/.test(
      normalized
    ) || /\b(run|do)\b.*\b(one[ -]?time|manual|manually)\b.*\b(digest|checks?)\b/.test(normalized);
  if (directRun) return true;

  const previous = lastAssistantMessage(history)?.toLowerCase().replace(/[’]/g, "'");
  if (!previous) return false;
  const offeredManualDigest =
    /\bsame checks manually\b/.test(previous) || /\bone[ -]?time digest now\b/.test(previous);
  if (!offeredManualDigest) return false;

  return (
    /^(yes|yep|yeah|sure|ok|okay|do it|go ahead)\b/.test(normalized) ||
    /\bdo it manually\b/.test(normalized) ||
    /\brun it\b/.test(normalized)
  );
}

function matchesMissingDigestRetry(text: string, history: ResponseInputItem[]): boolean {
  const normalized = normalize(text);
  const asksRetry =
    /^(yes|yep|yeah|sure|ok|okay)\b.*\b(retry|try again|missing|gmail|email|mail|calendar|asana|parts?)\b/.test(
      normalized
    ) ||
    /\b(retry|try again)\b.*\b(missing|gmail|email|mail|calendar|asana|parts?)\b/.test(normalized);
  if (!asksRetry) return false;
  const previous = lastAssistantMessage(history)?.toLowerCase().replace(/[’]/g, "'");
  return Boolean(previous && /morning digest|automation|digest/.test(previous));
}

function matchesRecentGoogleDocDelete(text: string, memoryEntries: PromptMemoryEntry[]): boolean {
  const normalized = normalize(text);
  if (!/\b(delete|trash|remove|get rid of)\b/.test(normalized)) return false;
  if (!memoryEntries.some((entry) => entry.key === "recent_google_doc")) return false;
  return (
    /\b(google doc|doc|docs|document)\b/.test(normalized) ||
    /\b(delete|trash|remove|get rid of)\s+(it|that|this|same one|current one|that|this|same|current)\b/.test(
      normalized
    )
  );
}

function extractAsanaProjectTaskName(text: string): string | null {
  const patterns = [
    /\b(?:show|list|check)\b[^.?!]*\btasks?\s+in\s+(?:project\s+)?([a-z0-9][a-z0-9 _-]{1,60})\b/i,
    /\b(?:show|list|check)\b[^.?!]*\bproject\s+([a-z0-9][a-z0-9 _-]{1,60})\s+tasks?\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const projectName = cleanupEntity(match?.[1]);
    if (projectName) return projectName;
  }
  return null;
}

function cleanupEntity(value: string | undefined): string | null {
  const cleaned = value
    ?.replace(/\b(?:due|today|tomorrow|overdue|open|incomplete|completed|complete)\b.*$/i, "")
    .trim();
  return cleaned || null;
}

function isShortCancel(normalized: string): boolean {
  return /^(cancel|stop|never mind|nevermind)$/.test(normalized);
}

function isShortPendingReference(normalized: string): boolean {
  return /^(send|send it|confirm|yes|sure|ok|okay|go ahead|do it|do that|book it|create it)$/.test(
    normalized
  );
}

function isWeakScheduleStatement(normalized: string): boolean {
  return /\b(?:my\s+)?schedule\s+(?:looks|seems|feels|is|was)\b/.test(normalized);
}

function countActionMentions(normalized: string): number {
  let count = 0;
  for (const pattern of ACTION_PATTERNS) {
    const matches = normalized.match(pattern);
    count += matches?.length ?? 0;
  }
  return count;
}

function lastAssistantMessage(history: ResponseInputItem[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.role !== "assistant") continue;
    return typeof item.content === "string" ? item.content : null;
  }
  return null;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[’]/g, "'").trim();
}
