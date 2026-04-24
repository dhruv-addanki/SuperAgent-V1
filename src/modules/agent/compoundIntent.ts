export type ReferencedApp = "asana" | "calendar" | "gmail" | "docs" | "drive" | "web";

const APP_ORDER: ReferencedApp[] = ["web", "calendar", "gmail", "drive", "docs", "asana"];
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

export function detectReferencedApps(text: string): ReferencedApp[] {
  const normalized = text.toLowerCase();
  const original = text.trim();
  const apps = new Set<ReferencedApp>();

  if (referencesWeb(normalized, original)) apps.add("web");
  if (referencesCalendar(normalized)) apps.add("calendar");
  if (referencesGmail(normalized)) apps.add("gmail");
  if (referencesDrive(normalized)) apps.add("drive");
  if (referencesDocs(normalized)) apps.add("docs");
  if (referencesAsana(normalized)) apps.add("asana");

  return APP_ORDER.filter((app) => apps.has(app));
}

export function isCompoundIntentRequest(text: string): boolean {
  const apps = detectReferencedApps(text);
  if (apps.length > 1) return true;

  const normalized = text.toLowerCase();
  if (!/\b(?:and|then|also|plus)\b|[;,]/.test(normalized)) return false;
  return countActionMentions(normalized) >= 2;
}

function referencesWeb(normalized: string, original: string): boolean {
  return (
    /\b(look up|online|web|internet)\b/.test(normalized) ||
    /\bsearch\b.*\b(web|internet|online)\b/.test(normalized) ||
    /\bgoogle (?:it|this|that)\b/.test(normalized) ||
    /\b(stock|stocks|share|shares|market|earnings|ticker)\b/.test(normalized) ||
    (/\b[A-Z]{2,5}\b/.test(original) && /\b(why|up|down|news|today|price|move|moving)\b/.test(normalized))
  );
}

function referencesCalendar(normalized: string): boolean {
  return (
    /\b(cal|calendar|event|meeting|appointment|reminder|remind)\b/.test(normalized) ||
    /\b(schedule|reschedule|book)\b/.test(normalized)
  );
}

function referencesGmail(normalized: string): boolean {
  return /\b(gmail|email|e-mail|draft|thread|inbox)\b/.test(normalized);
}

function referencesDrive(normalized: string): boolean {
  return /\b(google drive|drive file|drive folder|folder|file)\b/.test(normalized);
}

function referencesDocs(normalized: string): boolean {
  return /\b(google doc|doc|docs|document|append)\b/.test(normalized);
}

function referencesAsana(normalized: string): boolean {
  return /\b(asana|my tasks|asana tasks?|project tasks?|due task|due tasks)\b/.test(normalized);
}

function countActionMentions(normalized: string): number {
  let count = 0;
  for (const pattern of ACTION_PATTERNS) {
    const matches = normalized.match(pattern);
    count += matches?.length ?? 0;
  }
  return count;
}
