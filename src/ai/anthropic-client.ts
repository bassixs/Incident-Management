import Anthropic from '@anthropic-ai/sdk';

import { getConfig } from '../config';

let client: Anthropic | undefined;

/**
 * Shared Anthropic client.
 *
 * This is the only file in the codebase that knows which LLM vendor is in use;
 * everything else depends on the IncidentClassifier / AnswerDraftGenerator /
 * ModerationService interfaces, so swapping providers is a change here plus a
 * new implementation class.
 */
export function getAnthropic(): Anthropic {
  const config = getConfig();
  if (!config.AI_API_KEY) {
    throw new Error('AI_API_KEY is not configured');
  }
  client ??= new Anthropic({
    apiKey: config.AI_API_KEY,
    ...(config.AI_BASE_URL ? { baseURL: config.AI_BASE_URL } : {}),
    timeout: config.AI_TIMEOUT_MS,
    maxRetries: 1,
  });
  return client;
}

export function resetAnthropicClient(): void {
  client = undefined;
}
