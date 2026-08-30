import * as z from 'zod/v4';

import { getConfig } from '../config';
import { AppError } from '../utils/errors';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type CompletionOptions = {
  maxTokens?: number;
  /** Ask for strict structured output instead of free text. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
};

type ChatCompletionResponse = {
  error?: { message?: string; code?: number | string };
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; refusal?: string | null };
  }>;
};

/**
 * Minimal client for an OpenAI-compatible Chat Completions endpoint.
 *
 * Deliberately not the `openai` SDK: this codebase needs exactly one endpoint,
 * and a hand-rolled adapter keeps the AI layer dependency-free and honest
 * about the wire format. Verified against AITunnel (api.aitunnel.ru/v1), which
 * is what "OpenAI-compatible" means in practice for any such gateway.
 */
export class OpenAiCompatibleClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
    },
  ) {}

  private endpoint(): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages,
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options.jsonSchema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: options.jsonSchema.name,
                strict: true,
                schema: options.jsonSchema.schema,
              },
            },
          }
        : {}),
    };

    let response: Response;
    try {
      response = await fetch(this.endpoint(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new AppError(
        `Не удалось обратиться к AI: ${error instanceof Error ? error.message : String(error)}`,
        'AI_UNREACHABLE',
      );
    }

    const data = (await response.json().catch(() => ({}))) as ChatCompletionResponse;

    // Gateways may report a failure in the body with an HTTP 200.
    if (data.error) {
      throw new AppError(`AI вернул ошибку: ${data.error.message ?? 'без описания'}`, 'AI_ERROR');
    }
    if (!response.ok) {
      throw new AppError(`AI вернул HTTP ${response.status}.`, 'AI_ERROR');
    }

    const choice = data.choices?.[0];
    if (choice?.message?.refusal) {
      throw new AppError('AI отказался отвечать на этот запрос.', 'AI_REFUSAL');
    }
    if (choice?.finish_reason === 'length') {
      // A reasoning model can spend the budget before emitting the answer;
      // a truncated payload would parse into nonsense, so fail loudly.
      throw new AppError('Ответ AI обрезан по лимиту токенов.', 'AI_TRUNCATED');
    }

    const content = choice?.message?.content?.trim();
    if (!content) throw new AppError('AI вернул пустой ответ.', 'AI_EMPTY');
    return content;
  }

  /** Strict structured output, validated against the same schema on the way back. */
  async completeJson<T>(
    messages: ChatMessage[],
    schema: z.ZodType<T>,
    name: string,
    maxTokens?: number,
  ): Promise<T> {
    const content = await this.complete(messages, {
      jsonSchema: { name, schema: toStrictJsonSchema(schema) },
      ...(maxTokens ? { maxTokens } : {}),
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new AppError('AI вернул не-JSON там, где ожидался JSON.', 'AI_BAD_JSON');
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new AppError('Ответ AI не соответствует ожидаемой структуре.', 'AI_BAD_SHAPE');
    }
    return result.data;
  }
}

/**
 * One schema definition serves both providers: zod drives Anthropic's
 * structured output helper and, converted here, OpenAI's strict json_schema.
 * `$schema` is dropped because strict mode rejects unknown top-level keys.
 */
export function toStrictJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

let client: OpenAiCompatibleClient | undefined;

export function getOpenAiClient(): OpenAiCompatibleClient {
  const config = getConfig();
  if (!config.AI_API_KEY) throw new AppError('AI_API_KEY не задан.', 'AI_NOT_CONFIGURED');
  client ??= new OpenAiCompatibleClient({
    baseUrl: config.AI_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: config.AI_API_KEY,
    model: config.AI_MODEL,
    timeoutMs: config.AI_TIMEOUT_MS,
  });
  return client;
}

export function resetOpenAiClient(): void {
  client = undefined;
}
