import OpenAI from "openai";
import { env } from "../config/env";

export type ResponseInputItem = Record<string, unknown>;
export type ResponseToolDefinition = Record<string, unknown>;

export interface ResponsesApiResponse {
  id?: string;
  output?: Array<Record<string, any>>;
  output_text?: string;
}

export interface ResponsesClient {
  createResponse(params: {
    model: string;
    instructions: string;
    tools: ResponseToolDefinition[];
    input: Array<ResponseInputItem | Record<string, unknown>>;
    tool_choice?: "auto" | "required" | Record<string, unknown>;
  }): Promise<ResponsesApiResponse>;
}

export class OpenAIResponsesClient implements ResponsesClient {
  private readonly client: OpenAI;

  constructor(apiKey = env.OPENAI_API_KEY) {
    this.client = new OpenAI({ apiKey });
  }

  async createResponse(params: Parameters<ResponsesClient["createResponse"]>[0]) {
    return (await this.client.responses.create(params as any)) as ResponsesApiResponse;
  }
}

export function createOpenAIClient(): ResponsesClient {
  return new OpenAIResponsesClient();
}
