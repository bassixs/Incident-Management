import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Category } from '@prisma/client';
import * as z from 'zod/v4';

import { getConfig } from '../config';
import { moduleLogger } from '../utils/logger';
import { truncate } from '../utils/text';
import { getAnthropic } from './anthropic-client';
import { getOpenAiClient } from './openai-client';
import {
  EMPTY_CLASSIFICATION,
  type ClassificationResult,
  type IncidentClassifier,
} from './classifier.interface';

const log = moduleLogger('ai-classifier');

/** Used when AI_ENABLED=false — the workflow behaves identically. */
export class NullIncidentClassifier implements IncidentClassifier {
  readonly enabled = false;

  async classify(): Promise<ClassificationResult> {
    return EMPTY_CLASSIFICATION;
  }
}

const SuggestionSchema = z.object({
  category_code: z.string(),
  confidence: z.number(),
  reason: z.string(),
});

const ClassificationSchema = z.object({
  suggestions: z.array(SuggestionSchema),
});

const SYSTEM_PROMPT = [
  'Ты помогаешь диспетчеру службы поддержки определить сферу обращения.',
  'Тебе дают текст обращения и закрытый список сфер.',
  'Верни до трёх наиболее вероятных сфер из списка, отсортированных по убыванию уверенности.',
  'confidence — число от 0 до 1. reason — одно короткое предложение на русском языке.',
  'Используй только коды сфер из предоставленного списка. Ничего не назначай и не решай за диспетчера.',
].join(' ');

export class ClaudeIncidentClassifier implements IncidentClassifier {
  readonly enabled = true;

  async classify(text: string, categories: Category[]): Promise<ClassificationResult> {
    const config = getConfig();
    const usable = categories.filter((category) => category.isActive);
    if (usable.length === 0 || text.trim().length === 0) return EMPTY_CLASSIFICATION;

    try {
      const response = await getAnthropic().messages.parse({
        model: config.AI_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(text, usable) }],
        output_config: { format: zodOutputFormat(ClassificationSchema) },
      });

      const parsed = response.parsed_output;
      if (!parsed) {
        log.warn('classifier returned unparsable output');
        return EMPTY_CLASSIFICATION;
      }

      return { suggestions: mapSuggestions(parsed.suggestions, usable, config.AI_MAX_SUGGESTIONS) };
    } catch (error) {
      // AI is never a hard dependency: registration continues without a hint.
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'classification failed');
      return EMPTY_CLASSIFICATION;
    }
  }
}

/**
 * Same job through any OpenAI-compatible gateway (AITunnel, OpenRouter, ...).
 * Shares the prompt and the zod schema with the Anthropic implementation, so
 * switching providers cannot silently change what the dispatcher sees.
 */
export class OpenAiIncidentClassifier implements IncidentClassifier {
  readonly enabled = true;

  async classify(text: string, categories: Category[]): Promise<ClassificationResult> {
    const config = getConfig();
    const usable = categories.filter((category) => category.isActive);
    if (usable.length === 0 || text.trim().length === 0) return EMPTY_CLASSIFICATION;

    try {
      const parsed = await getOpenAiClient().completeJson(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(text, usable) },
        ],
        ClassificationSchema,
        'incident_classification',
        1024,
      );
      return { suggestions: mapSuggestions(parsed.suggestions, usable, config.AI_MAX_SUGGESTIONS) };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'classification failed');
      return EMPTY_CLASSIFICATION;
    }
  }
}

function buildUserPrompt(text: string, categories: Category[]): string {
  return [
    'Доступные сферы:',
    categories.map((category) => `- ${category.code}: ${category.name}`).join('\n'),
    '',
    'Текст обращения:',
    truncate(text, 1000),
  ].join('\n');
}

/** Drops anything the model invented and keeps the best few, highest first. */
function mapSuggestions(
  raw: Array<{ category_code: string; confidence: number; reason: string }>,
  categories: Category[],
  limit: number,
): ClassificationResult['suggestions'] {
  const byCode = new Map(categories.map((category) => [category.code.toUpperCase(), category]));
  return raw
    .map((suggestion) => {
      const category = byCode.get(suggestion.category_code.trim().toUpperCase());
      if (!category) return null;
      return {
        categoryId: category.id,
        confidence: clamp(suggestion.confidence),
        reason: suggestion.reason,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, limit);
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function createIncidentClassifier(): IncidentClassifier {
  const config = getConfig();
  if (!config.AI_ENABLED) return new NullIncidentClassifier();
  return config.AI_PROVIDER === 'openai' ? new OpenAiIncidentClassifier() : new ClaudeIncidentClassifier();
}
