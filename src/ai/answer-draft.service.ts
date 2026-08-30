import type { Category, Incident } from '@prisma/client';

import { getConfig } from '../config';
import { AppError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import { truncate } from '../utils/text';
import type { AnswerDraftGenerator } from './answer-draft.interface';
import { getAnthropic } from './anthropic-client';
import { getOpenAiClient } from './openai-client';

const log = moduleLogger('ai-draft');

export class NullAnswerDraftGenerator implements AnswerDraftGenerator {
  readonly enabled = false;

  async generate(): Promise<string> {
    throw new AppError('AI-черновик отключён (AI_ENABLED=false).', 'AI_DISABLED');
  }
}

const SYSTEM_PROMPT = [
  'Ты помогаешь сотруднику подготовить черновик официального ответа на обращение.',
  'Пиши по-русски, вежливо, по делу, без канцелярита и без обещаний, которых нет в обращении.',
  'Не более 700 символов. Не придумывай факты, сроки и фамилии — вместо них оставляй',
  'квадратные скобки, например [срок устранения], чтобы сотрудник заполнил их вручную.',
  'Не здоровайся дважды и не подписывайся.',
].join(' ');

export class ClaudeAnswerDraftGenerator implements AnswerDraftGenerator {
  readonly enabled = true;

  async generate(incident: Incident, category: Category, template?: string | null): Promise<string> {
    const config = getConfig();
    try {
      const response = await getAnthropic().messages.create({
        model: config.AI_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildDraftPrompt(incident, category, template) }],
      });

      const text = response.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      if (!text) throw new AppError('Модель вернула пустой черновик.', 'AI_EMPTY');
      return text;
    } catch (error) {
      log.error(
        { incidentId: incident.id, publicCode: incident.publicCode, err: error instanceof Error ? error.message : String(error) },
        'answer draft generation failed',
      );
      throw error instanceof AppError
        ? error
        : new AppError('Не удалось сгенерировать черновик. Попробуйте ещё раз или напишите ответ вручную.', 'AI_FAILED');
    }
  }
}

/** The same draft through any OpenAI-compatible gateway. */
export class OpenAiAnswerDraftGenerator implements AnswerDraftGenerator {
  readonly enabled = true;

  async generate(incident: Incident, category: Category, template?: string | null): Promise<string> {
    try {
      return await getOpenAiClient().complete(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildDraftPrompt(incident, category, template) },
        ],
        { maxTokens: 2048 },
      );
    } catch (error) {
      log.error(
        {
          incidentId: incident.id,
          publicCode: incident.publicCode,
          err: error instanceof Error ? error.message : String(error),
        },
        'answer draft generation failed',
      );
      throw error instanceof AppError
        ? error
        : new AppError(
            'Не удалось сгенерировать черновик. Попробуйте ещё раз или напишите ответ вручную.',
            'AI_FAILED',
          );
    }
  }
}

function buildDraftPrompt(incident: Incident, category: Category, template?: string | null): string {
  return [
    `Сфера: ${category.name}`,
    `Номер обращения: ${incident.publicCode}`,
    '',
    'Текст обращения:',
    truncate(incident.text, 1000),
    ...(template
      ? ['', 'Шаблон ответа этой сферы (следуй его структуре):', truncate(template, 1200)]
      : []),
    '',
    'Составь черновик ответа заявителю.',
  ].join('\n');
}

export function createAnswerDraftGenerator(): AnswerDraftGenerator {
  const config = getConfig();
  if (!config.AI_ENABLED) return new NullAnswerDraftGenerator();
  return config.AI_PROVIDER === 'openai'
    ? new OpenAiAnswerDraftGenerator()
    : new ClaudeAnswerDraftGenerator();
}
