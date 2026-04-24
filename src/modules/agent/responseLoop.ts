import { env } from "../../config/env";
import type {
  ResponseInputItem,
  ResponsesApiResponse,
  ResponsesClient,
  ResponseToolDefinition
} from "../../lib/openaiClient";
import { isReadOnlyTool, isToolName } from "../../schemas/toolSchemas";
import { formatToolResultForModel } from "./communicationFormatter";
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

interface ExecutedToolCall {
  call: FunctionCall;
  result: ToolExecutionResult;
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
          "I couldn't finish that cleanly in one pass. Try a narrower follow-up.",
        toolRounds,
        stoppedForMaxRounds: true
      };
    }

    currentInput = currentInput.concat((response.output ?? []) as ResponseInputItem[]);
    const executedCalls = await executeToolBatch(calls, input.executeTool);

    if (executedCalls.length === 1) {
      const { result } = executedCalls[0]!;

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
    } else {
      const shouldReturnBatchSummary = executedCalls.some(
        ({ result }) => result.stopAfterTool || result.approvalRequired || !result.ok
      );
      if (shouldReturnBatchSummary) {
        return {
          assistantMessage: formatBatchStatusMessage(executedCalls),
          toolRounds,
          stoppedForApproval: executedCalls.some(({ result }) => result.approvalRequired)
        };
      }
    }

    const toolOutputItems = executedCalls.map(
      ({ call, result }) =>
        ({
          type: "function_call_output",
          call_id: call.callId,
          output: JSON.stringify(formatToolResultForModel(call.name, result))
        }) satisfies ResponseInputItem
    );

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

async function executeToolBatch(
  calls: FunctionCall[],
  executeTool: (toolName: string, input: unknown) => Promise<ToolExecutionResult>
): Promise<ExecutedToolCall[]> {
  if (calls.every((call) => isToolName(call.name) && isReadOnlyTool(call.name))) {
    return Promise.all(calls.map((call) => executeOneToolCall(call, executeTool)));
  }

  const results: ExecutedToolCall[] = [];
  for (const call of calls) {
    results.push(await executeOneToolCall(call, executeTool));
  }
  return results;
}

async function executeOneToolCall(
  call: FunctionCall,
  executeTool: (toolName: string, input: unknown) => Promise<ToolExecutionResult>
): Promise<ExecutedToolCall> {
  try {
    return {
      call,
      result: await executeTool(call.name, call.arguments)
    };
  } catch (error) {
    return {
      call,
      result: {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        userMessage: `I couldn't complete the ${toolLabel(call.name)} step.`
      }
    };
  }
}

function formatBatchStatusMessage(executedCalls: ExecutedToolCall[]): string {
  const completed: string[] = [];
  const needsAttention: string[] = [];
  const failed: string[] = [];

  for (const { call, result } of executedCalls) {
    const summary = summarizeToolCall(call, result);
    if (result.approvalRequired) {
      needsAttention.push(summary);
    } else if (!result.ok) {
      failed.push(summary);
    } else {
      completed.push(summary);
    }
  }

  const sections: string[] = [];
  if (completed.length) sections.push(formatStatusSection("Completed:", completed));
  if (needsAttention.length) sections.push(formatStatusSection("Needs confirmation:", needsAttention));
  if (failed.length) sections.push(formatStatusSection("Couldn't complete:", failed));
  return sections.join("\n\n") || "Done.";
}

function summarizeToolCall(call: FunctionCall, result: ToolExecutionResult): string {
  if (result.userMessage) return `${toolLabel(call.name)}: ${result.userMessage}`;

  const formatted = formatToolResultForModel(call.name, result);
  const communication = formatted.communication as { summary?: unknown } | undefined;
  if (typeof communication?.summary === "string" && communication.summary.trim()) {
    return `${toolLabel(call.name)}: ${communication.summary.trim()}`;
  }

  if (!result.ok) return `${toolLabel(call.name)}: I couldn't complete that step.`;
  return `${toolLabel(call.name)}: Done.`;
}

function formatStatusSection(title: string, items: string[]): string {
  return [title, ...items.map((item) => `- ${item}`)].join("\n");
}

function toolLabel(toolName: string): string {
  if (toolName.startsWith("asana_")) return "Asana";
  if (toolName.startsWith("calendar_")) return "Calendar";
  if (toolName.startsWith("gmail_")) return "Gmail";
  if (toolName.startsWith("drive_")) return "Drive";
  if (toolName.startsWith("docs_")) return "Docs";
  if (toolName === "web_search") return "Web";
  return "Tool";
}
