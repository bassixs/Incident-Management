import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';

import { getConfig } from '../config';
import { moduleLogger } from '../utils/logger';
import { truncate } from '../utils/text';
import { getAnthropic } from './anthropic-client';
import { getOpenAiClient } from './openai-client';
import { CLEAN_MODERATION, type ModerationResult, type ModerationService } from './moderation.interface';

const log = moduleLogger('ai-moderation');

export class NullModerationService implements ModerationService {
  readonly enabled = false;

  async analyze(): Promise<ModerationResult> {
    return CLEAN_MODERATION;
  }
}

const ModerationSchema = z.object({
  possible_abuse: z.boolean(),
  possible_offtopic: z.boolean(),
  reason: z.string(),
});

const SYSTEM_PROMPT = [
  'Ты — вспомогательный фильтр для службы приёма обращений.',
  'Оцени текст обращения и отметь два признака:',
  'possible_abuse — оскорбления, брань, угрозы, флуд, явное злоупотребление системой;',
  'possible_offtopic — сообщение не является обращением о проблеме или инциденте.',
  'reason — одно короткое предложение на русском. Это только подсказка человеку:',
  'ты никого не блокируешь и ничего не отклоняешь.',
].join(' ');

export class ClaudeModerationService implements ModerationService {
  readonly enabled = true;

  async analyze(text: string): Promise<ModerationResult> {
    const config = getConfig();
    try {
      const response = await getAnthropic().messages.parse({
        model: config.AI_MODEL,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: truncate(text, 1000) }],
        output_config: { format: zodOutputFormat(ModerationSchema) },
      });

      const parsed = response.parsed_output;
      if (!parsed) return CLEAN_MODERATION;
      return {
        possibleAbuse: parsed.possible_abuse,
        possibleOfftopic: parsed.possible_offtopic,
        reason: parsed.reason,
      };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'moderation failed');
      return CLEAN_MODERATION;
    }
  }
}

/** The same hint through any OpenAI-compatible gateway. */
export class OpenAiModerationService implements ModerationService {
  readonly enabled = true;

  async analyze(text: string): Promise<ModerationResult> {
    try {
      const parsed = await getOpenAiClient().completeJson(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: truncate(text, 1000) },
        ],
        ModerationSchema,
        'incident_moderation',
        512,
      );
      return {
        possibleAbuse: parsed.possible_abuse,
        possibleOfftopic: parsed.possible_offtopic,
        reason: parsed.reason,
      };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'moderation failed');
      return CLEAN_MODERATION;
    }
  }
}

export function createModerationService(): ModerationService {
  const config = getConfig();
  if (!config.AI_ENABLED || !config.AI_MODERATION_ENABLED) return new NullModerationService();
  return config.AI_PROVIDER === 'openai' ? new OpenAiModerationService() : new ClaudeModerationService();
}
