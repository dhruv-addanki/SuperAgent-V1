export function normalizeAssistantMessageForUser(message: string): string {
  return message
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/([^\n])[ \t]+-[ \t]+([^\n])/g, "$1, $2")
    .replace(/-{3,}/g, ", ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
