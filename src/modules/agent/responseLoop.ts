import { env } from "../../config/env";
import type {
  ResponseInputItem,
  ResponsesApiResponse,
  ResponsesClient,
  ResponseToolDefinition
} from "../../lib/openaiClient";
import type { ToolExecutionResult } from "./toolExecutor";

export interface FunctionCall {
  callId: string;
  name: string;
  arguments: unknown;
}

export interface ResponseLoopInput {
  client: ResponsesClient;
  model?: string;
  instructions: string;
  tools: ResponseToolDefinition[];
  input: ResponseInputItem[];
  executeTool: (toolName: string, input: unknown) => Promise<ToolExecutionResult>;
  maxToolRounds?: number;
}

export interface ResponseLoopResult {
  assistantMessage: string;
  toolRounds: number;
  stoppedForApproval?: boolean;
  stoppedForMaxRounds?: boolean;
}

export async function runResponseLoop(input: ResponseLoopInput): Promise<ResponseLoopResult> {
  const model = input.model ?? env.OPENAI_MODEL;
  const maxToolRounds = input.maxToolRounds ?? env.MAX_TOOL_ROUNDS;
  let currentInput: ResponseInputItem[] = [...input.input];
  let response = await input.client.createResponse({
    model,
    instructions: input.instructions,
    tools: input.tools,
    input: currentInput,
    tool_choice: "auto"
  });

  let toolRounds = 0;

  while (true) {
    const calls = extractFunctionCalls(response);
    if (!calls.length) {
      return {
        assistantMessage: extractOutputText(response) || "Done.",
        toolRounds
      };
    }

    if (toolRounds >= maxToolRounds) {
      return {
        assistantMessage:
          "I could not finish that safely in one pass. Please try a narrower request.",
        toolRounds,
        stoppedForMaxRounds: true
      };
    }

    currentInput = currentInput.concat((response.output ?? []) as ResponseInputItem[]);
    const toolOutputItems: ResponseInputItem[] = [];

    for (const call of calls) {
      const result = await input.executeTool(call.name, call.arguments);

      if (result.userMessage && result.stopAfterTool) {
        return {
          assistantMessage: result.userMessage,
          toolRounds
        };
      }

      if (result.userMessage && (result.approvalRequired || !result.ok)) {
        return {
          assistantMessage: result.userMessage,
          toolRounds,
          stoppedForApproval: result.approvalRequired
        };
      }

      toolOutputItems.push({
        type: "function_call_output",
        call_id: call.callId,
        output: JSON.stringify(result)
      });
    }

    toolRounds += 1;
    currentInput = currentInput.concat(toolOutputItems);
    response = await input.client.createResponse({
      model,
      instructions: input.instructions,
      tools: input.tools,
      input: currentInput,
      tool_choice: "auto"
    });
  }
}

export function extractFunctionCalls(response: ResponsesApiResponse): FunctionCall[] {
  return (response.output ?? [])
    .filter((item) => item.type === "function_call" && item.name && item.call_id)
    .map((item) => ({
      callId: String(item.call_id),
      name: String(item.name),
      arguments: parseArguments(item.arguments)
    }));
}

export function extractOutputText(response: ResponsesApiResponse): string {
  if (response.output_text) return response.output_text.trim();

  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (typeof content?.text === "string") parts.push(content.text);
      if (typeof content?.output_text === "string") parts.push(content.output_text);
    }
  }

  return parts.join("\n").trim();
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
