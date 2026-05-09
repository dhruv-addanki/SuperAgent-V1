import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";

export interface ObsidianContextGraphSyncResult {
  enabled: boolean;
  graphPath?: string;
  indexedCount: number;
  deletedCount: number;
  skippedCount: number;
  reason?: string;
}

export interface ObsidianContextGraphSearchResult {
  pcgId: string;
  type: string;
  label: string;
  summary: string;
  path: string;
  aliases: string[];
  sourcePaths: string[];
  confidence: number;
  evidenceCount: number;
  score: number;
}

interface ParsedContextGraphNode {
  pcgId: string;
  type: string;
  label: string;
  summary: string;
  path: string;
  aliases: string[];
  sourceIds: string[];
  sourcePaths: string[];
  confidence: number;
  evidenceCount: number;
  lastSeen: Date | null;
  contentHash: string;
  searchText: string;
}

interface SearchOptions {
  limit?: number;
  types?: string[];
  includeAgentContext?: boolean;
  fallbackHighSignal?: boolean;
}

type FrontmatterValue = string | number | boolean | string[] | null;
type Frontmatter = Record<string, FrontmatterValue>;

const DEFAULT_LIMIT = 7;
const MAX_SUMMARY_CHARS = 1600;
const MAX_SEARCH_TEXT_CHARS = 12000;
const MAX_PROMPT_LINE_CHARS = 900;
const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "ask",
  "but",
  "can",
  "check",
  "daily",
  "digest",
  "for",
  "from",
  "have",
  "into",
  "like",
  "make",
  "more",
  "need",
  "now",
  "only",
  "out",
  "show",
  "that",
  "the",
  "this",
  "today",
  "tomorrow",
  "use",
  "what",
  "with",
  "you",
  "your"
]);

export class ObsidianContextGraphService {
  private static readonly lastSyncByUser = new Map<string, number>();
  private static readonly inFlightSyncByUser = new Map<
    string,
    Promise<ObsidianContextGraphSyncResult>
  >();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly graphPath = env.OBSIDIAN_CONTEXT_GRAPH_PATH
  ) {}

  async syncForUser(userId: string): Promise<ObsidianContextGraphSyncResult> {
    const resolvedGraphPath = normalizeConfiguredPath(this.graphPath);
    if (!resolvedGraphPath) {
      return {
        enabled: false,
        indexedCount: 0,
        deletedCount: 0,
        skippedCount: 0,
        reason: "OBSIDIAN_CONTEXT_GRAPH_PATH is not configured."
      };
    }

    const inFlightKey = `${userId}:${resolvedGraphPath}`;
    const existing = ObsidianContextGraphService.inFlightSyncByUser.get(inFlightKey);
    if (existing) return existing;

    const promise = this.syncForUserUnsafe(userId, resolvedGraphPath).finally(() => {
      ObsidianContextGraphService.inFlightSyncByUser.delete(inFlightKey);
    });
    ObsidianContextGraphService.inFlightSyncByUser.set(inFlightKey, promise);
    return promise;
  }

  async search(
    userId: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<ObsidianContextGraphSearchResult[]> {
    await this.ensureFreshIndex(userId);

    const delegate = contextGraphDelegate(this.prisma);
    if (!delegate?.findMany) return [];

    const where: Record<string, unknown> = { userId };
    if (options.types?.length) {
      where.type = { in: options.types };
    }

    const rows = await delegate.findMany({
      where,
      orderBy: [{ confidence: "desc" }, { indexedAt: "desc" }],
      take: 250
    });
    const includeAgentContext = options.includeAgentContext ?? true;
    const fallbackHighSignal = options.fallbackHighSignal ?? true;
    const tokens = tokenize(query);
    const scored: ObsidianContextGraphSearchResult[] = rows
      .map((row: any): ObsidianContextGraphSearchResult => {
        const result = rowToSearchResult(row, scoreNode(row, query, tokens));
        if (result.type === "agent_context" && includeAgentContext) {
          result.score += 2.5;
        }
        return result;
      })
      .filter(
        (node: ObsidianContextGraphSearchResult) =>
          includeAgentContext || node.type !== "agent_context"
      );

    const relevant = scored
      .filter((node) => node.type === "agent_context" || node.score >= 1.25)
      .sort(sortSearchResults)
      .slice(0, options.limit ?? DEFAULT_LIMIT);

    if (!fallbackHighSignal || relevant.length >= Math.min(3, options.limit ?? DEFAULT_LIMIT)) {
      return relevant;
    }

    const existingIds = new Set(relevant.map((node) => node.pcgId));
    const fallbacks = scored
      .filter(
        (node) =>
          !existingIds.has(node.pcgId) &&
          node.type !== "source_conversation" &&
          node.confidence >= 0.96 &&
          node.evidenceCount >= 2
      )
      .sort(
        (left, right) =>
          right.confidence - left.confidence || right.evidenceCount - left.evidenceCount
      )
      .slice(0, Math.max(0, (options.limit ?? DEFAULT_LIMIT) - relevant.length));

    return [...relevant, ...fallbacks].slice(0, options.limit ?? DEFAULT_LIMIT);
  }

  async getPromptContextLines(
    userId: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<string[]> {
    const nodes = await this.search(userId, query, options);
    return nodes.map(formatPromptLine);
  }

  private async ensureFreshIndex(userId: string): Promise<void> {
    if (!env.OBSIDIAN_CONTEXT_GRAPH_AUTO_SYNC) return;
    const resolvedGraphPath = normalizeConfiguredPath(this.graphPath);
    if (!resolvedGraphPath) return;

    const key = `${userId}:${resolvedGraphPath}`;
    const now = Date.now();
    const lastSync = ObsidianContextGraphService.lastSyncByUser.get(key) ?? 0;
    const intervalMs = env.OBSIDIAN_CONTEXT_GRAPH_SYNC_INTERVAL_SECONDS * 1000;
    if (now - lastSync < intervalMs) return;

    try {
      const result = await this.syncForUser(userId);
      if (result.enabled) {
        ObsidianContextGraphService.lastSyncByUser.set(key, Date.now());
      }
    } catch (error) {
      logger.warn({ error }, "Failed to refresh Obsidian context graph index");
    }
  }

  private async syncForUserUnsafe(
    userId: string,
    resolvedGraphPath: string
  ): Promise<ObsidianContextGraphSyncResult> {
    const stat = await fs.stat(resolvedGraphPath).catch(() => null);
    if (!stat?.isDirectory()) {
      return {
        enabled: false,
        graphPath: resolvedGraphPath,
        indexedCount: 0,
        deletedCount: 0,
        skippedCount: 0,
        reason: "Configured Obsidian context graph folder does not exist."
      };
    }

    const delegate = contextGraphDelegate(this.prisma);
    if (!delegate?.upsert) {
      return {
        enabled: false,
        graphPath: resolvedGraphPath,
        indexedCount: 0,
        deletedCount: 0,
        skippedCount: 0,
        reason: "ObsidianContextGraphNode delegate is unavailable. Run Prisma generate/migrate."
      };
    }

    const markdownFiles = await listMarkdownFiles(resolvedGraphPath);
    const parsedNodes: ParsedContextGraphNode[] = [];
    let skippedCount = 0;

    for (const filePath of markdownFiles) {
      if (isSourceConversationPath(resolvedGraphPath, filePath)) {
        skippedCount += 1;
        continue;
      }

      const content = await fs.readFile(filePath, "utf8");
      const node = parseContextGraphNode({
        graphPath: resolvedGraphPath,
        filePath,
        content
      });
      if (!node) {
        skippedCount += 1;
        continue;
      }
      parsedNodes.push(node);
    }

    for (const node of parsedNodes) {
      await delegate.upsert({
        where: { userId_pcgId: { userId, pcgId: node.pcgId } },
        update: {
          type: node.type,
          label: node.label,
          summary: node.summary,
          path: node.path,
          aliases: node.aliases as any,
          sourceIds: node.sourceIds as any,
          sourcePaths: node.sourcePaths as any,
          confidence: node.confidence,
          evidenceCount: node.evidenceCount,
          lastSeen: node.lastSeen,
          contentHash: node.contentHash,
          searchText: node.searchText,
          indexedAt: new Date()
        },
        create: {
          userId,
          pcgId: node.pcgId,
          type: node.type,
          label: node.label,
          summary: node.summary,
          path: node.path,
          aliases: node.aliases as any,
          sourceIds: node.sourceIds as any,
          sourcePaths: node.sourcePaths as any,
          confidence: node.confidence,
          evidenceCount: node.evidenceCount,
          lastSeen: node.lastSeen,
          contentHash: node.contentHash,
          searchText: node.searchText
        }
      });
    }

    let deletedCount = 0;
    if (parsedNodes.length) {
      const keepIds = parsedNodes.map((node) => node.pcgId);
      const deleted = await delegate.deleteMany({
        where: {
          userId,
          pcgId: { notIn: keepIds }
        }
      });
      deletedCount = typeof deleted?.count === "number" ? deleted.count : 0;
    }

    return {
      enabled: true,
      graphPath: resolvedGraphPath,
      indexedCount: parsedNodes.length,
      deletedCount,
      skippedCount
    };
  }
}

function contextGraphDelegate(prisma: PrismaClient): any {
  return (prisma as any).obsidianContextGraphNode;
}

function normalizeConfiguredPath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function isSourceConversationPath(graphPath: string, filePath: string): boolean {
  const relativePath = toVaultRelativePath(graphPath, filePath).toLowerCase();
  return relativePath.includes("/sources/");
}

function parseContextGraphNode(input: {
  graphPath: string;
  filePath: string;
  content: string;
}): ParsedContextGraphNode | null {
  const { frontmatter, body } = splitFrontmatter(input.content);
  if (frontmatter.pcg_managed !== true) return null;

  const type = asString(frontmatter.pcg_type);
  if (!type || type === "source_conversation") return null;

  const pcgId = asString(frontmatter.pcg_id) || `${type}_${shortHash(input.filePath)}`;
  const label = extractLabel(body, input.filePath);
  const summary = truncate(
    extractSection(body, type === "agent_context" ? "Profile Summary" : "Summary") ||
      extractFirstParagraph(body) ||
      label,
    MAX_SUMMARY_CHARS
  );
  const aliases = asStringArray(frontmatter.pcg_aliases);
  const sourceIds = asStringArray(frontmatter.pcg_source_ids);
  const sourcePaths = asStringArray(frontmatter.pcg_source_paths);
  const confidence = asNumber(frontmatter.pcg_confidence, type === "agent_context" ? 0.8 : 0);
  const evidenceCount = Math.max(0, Math.round(asNumber(frontmatter.pcg_evidence_count, 0)));
  const lastSeen = parseDate(asString(frontmatter.pcg_last_seen));
  const graphPathName = path.basename(input.graphPath);
  const relativePath = toVaultRelativePath(input.graphPath, input.filePath);
  const vaultPath = normalizePath(`${graphPathName}/${relativePath}`);
  const plainBody = markdownToPlainText(body);
  const searchText = truncate(
    [
      type,
      label,
      ...aliases,
      summary,
      extractSection(body, "Evidence"),
      extractSection(body, "Related Context"),
      type === "agent_context" ? extractAgentContextSearchSections(body) : "",
      plainBody
    ].join("\n"),
    MAX_SEARCH_TEXT_CHARS
  );

  return {
    pcgId,
    type,
    label,
    summary,
    path: vaultPath,
    aliases,
    sourceIds,
    sourcePaths,
    confidence,
    evidenceCount,
    lastSeen,
    contentHash: hash(input.content),
    searchText
  };
}

function splitFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  const endMatch = /\n---\s*\n/.exec(content.slice(3));
  if (!endMatch) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterStartOffset = 3;
  const frontmatterEndOffset = frontmatterStartOffset + endMatch.index;
  const frontmatterText = content.slice(frontmatterStartOffset, frontmatterEndOffset).trim();
  const bodyStart = frontmatterEndOffset + endMatch[0].length;
  return {
    frontmatter: parseFrontmatter(frontmatterText),
    body: content.slice(bodyStart)
  };
}

function parseFrontmatter(text: string): Frontmatter {
  const frontmatter: Frontmatter = {};
  let arrayKey: string | null = null;

  for (const line of text.split("\n")) {
    const keyMatch = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (keyMatch) {
      const key = keyMatch[1]!;
      const rawValue = keyMatch[2] ?? "";
      if (!rawValue.trim()) {
        frontmatter[key] = [];
        arrayKey = key;
      } else {
        frontmatter[key] = parseFrontmatterScalar(rawValue);
        arrayKey = null;
      }
      continue;
    }

    const itemMatch = /^\s*-\s*(.*)$/.exec(line);
    if (arrayKey && itemMatch) {
      const current = frontmatter[arrayKey];
      if (Array.isArray(current)) {
        current.push(String(parseFrontmatterScalar(itemMatch[1] ?? "")));
      }
    }
  }

  return frontmatter;
}

function parseFrontmatterScalar(value: string): FrontmatterValue {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  const unquoted = trimmed.replace(/^["']|["']$/g, "");
  if (/^-?\d+(?:\.\d+)?$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function extractLabel(body: string, filePath: string): string {
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const raw = heading || path.basename(filePath, ".md");
  return raw
    .replace(/^(?:Project|Topic|Entity|Preference|Decision|Task|Artifact|Style Pattern):\s*/i, "")
    .trim();
}

function extractSection(body: string, heading: string): string {
  const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m");
  const match = pattern.exec(body);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const nextHeading = /^##\s+/m.exec(rest);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  return markdownToPlainText(section).trim();
}

function extractAgentContextSearchSections(body: string): string {
  return [
    extractSection(body, "Projects"),
    extractSection(body, "Entities"),
    extractSection(body, "Preferences"),
    extractSection(body, "Decisions"),
    extractSection(body, "Tasks")
  ]
    .filter(Boolean)
    .join("\n");
}

function extractFirstParagraph(body: string): string {
  return (
    markdownToPlainText(body)
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .find(Boolean) ?? ""
  );
}

function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[\s>*-]*[-*\u2022]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreNode(row: any, query: string, tokens: string[]): number {
  const normalizedQuery = normalizeText(query);
  const label = normalizeText(row.label ?? "");
  const aliases = asStringArray(row.aliases).map(normalizeText);
  const summary = normalizeText(row.summary ?? "");
  const searchText = normalizeText(row.searchText ?? "");
  let score = 0;

  if (normalizedQuery && label && normalizedQuery.includes(label)) score += 8;
  if (label && normalizedQuery && label.includes(normalizedQuery)) score += 6;
  for (const alias of aliases) {
    if (alias && normalizedQuery.includes(alias)) score += 5;
  }

  for (const token of tokens) {
    if (label.includes(token)) score += 3.5;
    if (aliases.some((alias) => alias.includes(token))) score += 2.75;
    if (summary.includes(token)) score += 1.5;
    if (searchText.includes(token)) score += 0.8;
  }

  if (row.type === "preference" || row.type === "style_pattern" || row.type === "decision") {
    score += 0.5;
  }

  return score + Math.min(Number(row.confidence ?? 0), 1) * 0.75;
}

function rowToSearchResult(row: any, score: number): ObsidianContextGraphSearchResult {
  return {
    pcgId: String(row.pcgId ?? ""),
    type: String(row.type ?? ""),
    label: String(row.label ?? ""),
    summary: String(row.summary ?? ""),
    path: String(row.path ?? ""),
    aliases: asStringArray(row.aliases),
    sourcePaths: asStringArray(row.sourcePaths),
    confidence: Number(row.confidence ?? 0),
    evidenceCount: Number(row.evidenceCount ?? 0),
    score
  };
}

function sortSearchResults(
  left: ObsidianContextGraphSearchResult,
  right: ObsidianContextGraphSearchResult
): number {
  return (
    right.score - left.score ||
    right.confidence - left.confidence ||
    right.evidenceCount - left.evidenceCount ||
    left.label.localeCompare(right.label)
  );
}

function formatPromptLine(node: ObsidianContextGraphSearchResult): string {
  const aliases = node.aliases.length ? ` Aliases: ${node.aliases.slice(0, 5).join(", ")}.` : "";
  const evidence =
    node.evidenceCount > 0
      ? ` Evidence: ${node.evidenceCount} item${node.evidenceCount === 1 ? "" : "s"}.`
      : "";
  return truncate(
    `[${node.type}] ${node.label} (${round(node.confidence)} confidence). ${node.summary}${aliases}${evidence} Source: ${node.path}`,
    MAX_PROMPT_LINE_CHARS
  );
}

function tokenize(value: string): string[] {
  const tokens = normalizeText(value)
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  return Array.from(new Set(tokens)).slice(0, 40);
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseDate(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toVaultRelativePath(graphPath: string, filePath: string): string {
  return normalizePath(path.relative(graphPath, filePath));
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string): string {
  return hash(value).slice(0, 12);
}

function round(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
