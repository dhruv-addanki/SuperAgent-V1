import OpenAI from "openai";
import { env } from "../../config/env";
import { ExternalApiError } from "../../lib/errors";
import type { WebSearchResult } from "../google/googleTypes";

export class WebSearchService {
  private readonly client: OpenAI;

  constructor(apiKey = env.OPENAI_API_KEY) {
    this.client = new OpenAI({ apiKey });
  }

  async search(query: string, allowedDomains?: string[]): Promise<WebSearchResult> {
    try {
      const response = await this.client.responses.create({
        model: env.OPENAI_MODEL,
        input: query,
        tools: [
          {
            type: "web_search",
            filters: allowedDomains?.length
              ? {
                  allowed_domains: allowedDomains
                }
              : undefined,
            user_location: {
              type: "approximate",
              country: "US",
              timezone: env.NODE_ENV === "production" ? "America/New_York" : undefined
            }
          }
        ],
        include: ["web_search_call.action.sources"]
      } as any);

      return {
        query,
        summary: extractOutputText(response),
        sources: extractSources(response)
      };
    } catch (error) {
      throw new ExternalApiError("web", "I couldn't look that up on the web right now.", error);
    }
  }
}

function extractOutputText(response: any): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        parts.push(content.text.trim());
      } else if (typeof content?.output_text === "string" && content.output_text.trim()) {
        parts.push(content.output_text.trim());
      }
    }
  }

  return parts.join("\n").trim();
}

function extractSources(response: any): Array<{ title?: string; url: string }> {
  const seen = new Set<string>();
  const sources: Array<{ title?: string; url: string }> = [];

  for (const item of response.output ?? []) {
    if (item.type === "web_search_call") {
      for (const source of item.action?.sources ?? []) {
        if (typeof source?.url === "string" && !seen.has(source.url)) {
          seen.add(source.url);
          sources.push({
            title: typeof source?.title === "string" ? source.title : undefined,
            url: source.url
          });
        }
      }
    }

    if (item.type === "message") {
      for (const content of item.content ?? []) {
        for (const annotation of content?.annotations ?? []) {
          if (
            annotation?.type === "url_citation" &&
            typeof annotation?.url === "string" &&
            !seen.has(annotation.url)
          ) {
            seen.add(annotation.url);
            sources.push({
              title: typeof annotation?.title === "string" ? annotation.title : undefined,
              url: annotation.url
            });
          }
        }
      }
    }
  }

  return sources;
}
