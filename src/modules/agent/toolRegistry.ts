import { env } from "../../config/env";
import { buildToolDefinitions } from "../../schemas/toolSchemas";

export function getAvailableToolDefinitions() {
  return buildToolDefinitions(env.GOOGLE_READ_ONLY_MODE);
}
