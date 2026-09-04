import { Keyboard } from '@maxhub/max-bot-api';
import type { Button } from '../../max/max-types';
import type { Category } from '@prisma/client';
import type { ProblemMunicipality } from '../../locations/problem-locations';

import {
  incidentCallback,
  NOOP_CALLBACK,
  reportCallback,
  sessionCallback,
  userCallback,
} from '../../max/callback-payload';
import { PRESET_LABELS } from '../../reports/report-range';

const { button } = Keyboard;

/** Requester main menu (§53). */
export function mainMenuKeyboard(): Button[][] {
  return [
    [button.callback('📝 Создать обращение', userCallback('new'))],
    [button.callback('🔎 Мои обращения', userCallback('my-incidents'))],
    [button.callback('ℹ️ Правила', userCallback('rules'))],
  ];
}

/** Сферы shown per page of the requester's picker. */
export const CATEGORY_PAGE_SIZE = 6;

export function categoryPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / CATEGORY_PAGE_SIZE));
}

/**
 * Paged сфера picker (§7).
 *
 * With two dozen сферы a single list is a long scroll on a phone, so the page
 * shows a handful at a time with arrows. "Не знаю" stays pinned on top: it is
 * the honest answer for most people and the shortest path, and the choice is
 * only a hint for the dispatcher anyway.
 */
export function requesterCategoryKeyboard(categories: Category[], page = 0): Button[][] {
  const pages = categoryPageCount(categories.length);
  const current = Math.min(Math.max(page, 0), pages - 1);
  const slice = categories.slice(current * CATEGORY_PAGE_SIZE, (current + 1) * CATEGORY_PAGE_SIZE);

  const rows: Button[][] = [
    [button.callback('Не знаю', userCallback('category', 'none'))],
    ...slice.map((category) => [button.callback(category.name, userCallback('category', category.id))]),
  ];

  if (pages > 1) {
    const nav: Button[] = [];
    if (current > 0) nav.push(button.callback('⬅️ Назад', userCallback('page', String(current - 1))));
    nav.push(button.callback(`${current + 1} / ${pages}`, NOOP_CALLBACK));
    if (current < pages - 1) nav.push(button.callback('Вперёд ➡️', userCallback('page', String(current + 1))));
    rows.push(nav);
  }

  return rows;
}

export const MUNICIPALITY_PAGE_SIZE = 6;
export const LOCALITY_OTHER = 'other';
export const LOCALITY_SKIP = 'skip';

function locationArgument(selectedCategoryId: string | null, ...parts: Array<string | number>): string {
  return [selectedCategoryId ?? 'none', ...parts].join('~');
}

export function municipalityPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / MUNICIPALITY_PAGE_SIZE));
}

/** Территории на этапе создания обращения, по шесть кнопок на странице. */
export function requesterMunicipalityKeyboard(
  categoriesSelection: string | null,
  municipalities: ProblemMunicipality[],
  page = 0,
): Button[][] {
  const pages = municipalityPageCount(municipalities.length);
  const current = Math.min(Math.max(page, 0), pages - 1);
  const slice = municipalities.slice(
    current * MUNICIPALITY_PAGE_SIZE,
    (current + 1) * MUNICIPALITY_PAGE_SIZE,
  );
  const rows: Button[][] = slice.map((municipality) => [
    button.callback(
      municipality.name,
      userCallback('municipality', locationArgument(categoriesSelection, municipality.code)),
    ),
  ]);

  if (pages > 1) {
    const nav: Button[] = [];
    if (current > 0) {
      nav.push(
        button.callback(
          '⬅️ Назад',
          userCallback('location-page', locationArgument(categoriesSelection, current - 1)),
        ),
      );
    }
    nav.push(button.callback(`${current + 1} / ${pages}`, NOOP_CALLBACK));
    if (current < pages - 1) {
      nav.push(
        button.callback(
          'Вперёд ➡️',
          userCallback('location-page', locationArgument(categoriesSelection, current + 1)),
        ),
      );
    }
    rows.push(nav);
  }

  return rows;
}

/** Населённые пункты выбранного округа плюс явные «Другой» и «Пропустить». */
export function requesterLocalityKeyboard(
  selectedCategoryId: string | null,
  municipality: ProblemMunicipality,
): Button[][] {
  const argument = (localityCode: string) =>
    locationArgument(selectedCategoryId, municipality.code, localityCode);
  return [
    ...municipality.localities.map((locality) => [
      button.callback(locality.name, userCallback('locality', argument(locality.code))),
    ]),
    [button.callback('Другой', userCallback('locality', argument(LOCALITY_OTHER)))],
    [button.callback('Пропустить', userCallback('locality', argument(LOCALITY_SKIP)))],
  ];
}

/** Buttons under the distribution-chat card (§16). */
export function distributionKeyboard(incidentId: string): Button[][] {
  return [
    [button.callback('Распределить', incidentCallback('assign', incidentId), { intent: 'positive' })],
    [button.callback('Отклонить', incidentCallback('reject', incidentId), { intent: 'negative' })],
    [button.callback('Заблокировать автора', incidentCallback('ban', incidentId), { intent: 'negative' })],
  ];
}

/** Sector picker for a dispatcher (§17). The operator chooses — nothing is preselected. */
export function assignCategoryKeyboard(incidentId: string, categories: Category[]): Button[][] {
  const rows = categories.map((category) => [
    button.callback(category.name, incidentCallback('assign-category', incidentId, category.id)),
  ]);
  rows.push([button.callback('Отмена', incidentCallback('cancel', incidentId))]);
  return rows;
}

/** Buttons under the sector-chat card (§21). */
export function sectorKeyboard(incidentId: string, options: { hasTemplate: boolean }): Button[][] {
  const rows: Button[][] = [
    [button.callback('Взять в работу', incidentCallback('take', incidentId), { intent: 'positive' })],
    [button.callback('Подготовить ответ', incidentCallback('answer', incidentId))],
  ];
  if (options.hasTemplate) {
    rows.push([button.callback('Использовать шаблон', incidentCallback('template', incidentId))]);
  }
  return rows;
}

/** Buttons under the review-chat card (§29). */
export function reviewKeyboard(incidentId: string): Button[][] {
  return [
    [button.callback('✅ Согласовать', incidentCallback('approve', incidentId), { intent: 'positive' })],
    [button.callback('↩️ На доработку', incidentCallback('revision', incidentId), { intent: 'negative' })],
  ];
}

/** Button under the "returned for revision" card in the sector chat (§32). */
export function revisionKeyboard(incidentId: string): Button[][] {
  return [[button.callback('Исправить ответ', incidentCallback('fix', incidentId), { intent: 'positive' })]];
}

/** Period picker shown by a bare `/report` (§40). */
export function reportPeriodKeyboard(): Button[][] {
  return [
    [
      button.callback(PRESET_LABELS.today, reportCallback('today')),
      button.callback(PRESET_LABELS['7d'], reportCallback('7d')),
    ],
    [
      button.callback(PRESET_LABELS['30d'], reportCallback('30d')),
      button.callback(PRESET_LABELS.month, reportCallback('month')),
    ],
    [button.callback(PRESET_LABELS.all, reportCallback('all'))],
    [button.callback('📅 Указать период', reportCallback('custom'))],
  ];
}

/** Offered when an operator starts a new action with one already pending (§37). */
export function sessionConflictKeyboard(): Button[][] {
  return [
    [button.callback('Продолжить', sessionCallback('continue'), { intent: 'positive' })],
    [button.callback('Отменить', sessionCallback('cancel'), { intent: 'negative' })],
  ];
}
