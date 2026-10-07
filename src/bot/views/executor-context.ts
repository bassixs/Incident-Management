import type { Incident } from '@prisma/client';
import type { IncidentWithRelations } from '../../incidents/incident.repository';

/** A preview only. Full, unmodified content remains accessible through the viewer. */
export function excerpt(text: string, limit = 220): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit).join('') + '…';
}

/** Code-point pages preserve whitespace, links and surrogate pairs exactly. */
export function contextPages(text: string, limit = 2400): string[] {
  const chars = Array.from(text), pages: string[] = [];
  for (let i = 0; i < chars.length; i += limit) pages.push(chars.slice(i, i + limit).join(''));
  return pages.length ? pages : [''];
}

type ContextIncident = Incident & Partial<Pick<IncidentWithRelations, 'answers' | 'attachments'>>;
export function executorSummary(incident: ContextIncident): string[] {
  const latest = incident.answers?.at(-1);
  return [
    'Исходное сообщение:', excerpt(incident.text),
    ...(incident.attachments ? [`Исходных вложений: ${incident.attachments.length}`] : []),
    ...(incident.revisionReason ? ['', 'Последнее замечание согласующего:', excerpt(incident.revisionReason)] : []),
    '', latest ? `Последняя сохранённая версия ответа — ${latest.version}:` : 'Сохранённого проекта ответа пока нет.',
    ...(latest ? [excerpt(latest.text ?? 'Текст версии не сохранён.')] : []),
    '', 'Полный текст, фотографии и версии — по кнопке «Обращение и доработки».',
  ];
}
