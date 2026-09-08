import { Keyboard } from '@maxhub/max-bot-api';
import type { Button } from '../../max/max-types';
import type { Category, ResponsibleGroup } from '@prisma/client';
import type { ProblemMunicipality } from '../../locations/problem-locations';
import { LEGAL_CONFIRMATION_TEXT, type LegalDocumentLinks } from '../../legal/legal-acceptance.service';

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
    [button.callback('📄 Документы', userCallback('documents'))],
    [button.callback('ℹ️ Правила', userCallback('rules'))],
  ];
}

/** Permanent document links plus the next explicit, separate confirmation. */
export function legalDocumentsKeyboard(
  links: LegalDocumentLinks,
  options: { acceptance?: 'agreement' | 'consent' } = {},
): Button[][] {
  const rows: Button[][] = [];
  if (links.userAgreement) rows.push([button.link('Пользовательское соглашение', links.userAgreement)]);
  if (links.privacyPolicy) rows.push([button.link('Политика обработки данных', links.privacyPolicy)]);
  if (links.personalDataConsent) {
    rows.push([button.link('Согласие на обработку данных', links.personalDataConsent)]);
  }
  if (options.acceptance === 'agreement' && links.userAgreement) {
    rows.push([button.callback(LEGAL_CONFIRMATION_TEXT.userAgreement, userCallback('accept-agreement'), { intent: 'positive' })]);
  } else if (options.acceptance === 'consent' && links.personalDataConsent) {
    rows.push([button.callback(LEGAL_CONFIRMATION_TEXT.personalDataConsent, userCallback('accept-consent'), { intent: 'positive' })]);
  }
  rows.push([button.callback('Главное меню', userCallback('menu'))]);
  return rows;
}

export function agreementAcceptanceKeyboard(url: string): Button[][] {
  return [
    [button.link('Открыть соглашение', url)],
    [
      button.callback(
        'Принимаю пользовательское соглашение',
        userCallback('accept-agreement'),
        { intent: 'positive' },
      ),
    ],
    [button.callback('Главное меню', userCallback('menu'))],
  ];
}

export function personalDataConsentKeyboard(url: string): Button[][] {
  return [
    [button.link('Открыть согласие', url)],
    [
      button.callback(
        'Даю согласие на обработку персональных данных',
        userCallback('accept-consent'),
        { intent: 'positive' },
      ),
    ],
    [button.callback('Главное меню', userCallback('menu'))],
  ];
}

/** MAX asks the account owner before sending the contact bound to the account. */
export function requesterContactKeyboard(): Button[][] {
  return [[button.requestContact('📱 Поделиться контактом')]];
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
 * shows a handful at a time with arrows. "Иное" stays pinned on top: it is
 * the honest answer for most people and the shortest path, and the choice is
 * only a hint for the dispatcher anyway.
 */
export function requesterCategoryKeyboard(categories: Category[], page = 0): Button[][] {
  const pages = categoryPageCount(categories.length);
  const current = Math.min(Math.max(page, 0), pages - 1);
  const slice = categories.slice(current * CATEGORY_PAGE_SIZE, (current + 1) * CATEGORY_PAGE_SIZE);

  const rows: Button[][] = [
    [button.callback('Иное', userCallback('category', 'none'))],
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

/** Final requester checkpoint before an Incident row is created. */
export function incidentDraftConfirmationKeyboard(): Button[][] {
  return [
    [button.callback('✅ Всё верно', userCallback('draft-confirm'), { intent: 'positive' })],
    [button.callback('✏️ Исправить', userCallback('draft-edit'))],
  ];
}

/** Choose exactly one draft field; changing it never clears the other fields. */
export function incidentDraftEditKeyboard(hasPhoto: boolean): Button[][] {
  return [
    [button.callback('ФИО', userCallback('draft-field', 'name'))],
    [button.callback('Номер телефона', userCallback('draft-field', 'phone'))],
    [button.callback('Сфера обращения', userCallback('draft-field', 'category'))],
    [button.callback('Территория и населённый пункт', userCallback('draft-field', 'location'))],
    [button.callback('Текст обращения', userCallback('draft-field', 'text'))],
    [button.callback(hasPhoto ? 'Фотографии' : 'Добавить фотографию', userCallback('draft-field', 'photo'))],
    [button.callback('⬅️ Назад к проверке', userCallback('draft-edit', 'back'))],
  ];
}

export function incidentDraftPhotoKeyboard(hasPhoto: boolean): Button[][] {
  return [
    [button.callback(hasPhoto ? 'Заменить фотографии' : 'Добавить фотографию', userCallback('draft-photo', 'replace'))],
    ...(hasPhoto
      ? [[button.callback('Удалить фотографии', userCallback('draft-photo', 'remove'), { intent: 'negative' })]]
      : []),
    [button.callback('⬅️ Назад', userCallback('draft-edit'))],
  ];
}

export function incidentDraftPhotoRetryKeyboard(): Button[][] {
  return [[button.callback('Продолжить без фотографий', userCallback('draft-photo', 'remove'))]];
}

/** One immutable requester score for a delivered final answer. */
export function answerRatingKeyboard(incidentId: string): Button[][] {
  return [[1, 2, 3, 4, 5].map((rating) =>
    button.callback(String(rating), userCallback('rate-answer', `${incidentId}~${rating}`), {
      intent: rating >= 4 ? 'positive' : 'default',
    }),
  )];
}

/** Buttons under the distribution-chat card (§16). */
export function distributionKeyboard(incidentId: string): Button[][] {
  return [
    [button.callback('Распределить', incidentCallback('assign', incidentId), { intent: 'positive' })],
    [button.callback('Отклонить', incidentCallback('reject', incidentId), { intent: 'negative' })],
    [button.callback('Заблокировать автора', incidentCallback('ban', incidentId), { intent: 'negative' })],
  ];
}

export type AssignmentBranch = 'local' | 'executive';
export const ASSIGNMENT_PAGE_SIZE = 6;

/** First routing level: the regional team or one of two group families. */
export function assignmentBranchKeyboard(
  incidentId: string,
  regionalGroup: ResponsibleGroup | null,
  recommendedGroup: ResponsibleGroup | null,
): Button[][] {
  const rows: Button[][] = [];
  if (regionalGroup) {
    const recommended = regionalGroup.id === recommendedGroup?.id;
    rows.push([
      button.callback(
        recommended ? '⭐ Калужская область — рекомендуется' : 'Калужская область',
        incidentCallback('assign-group', incidentId, regionalGroup.id),
        { intent: recommended ? 'positive' : 'default' },
      ),
    ]);
  }
  rows.push([
    button.callback('Органы местного самоуправления', incidentCallback('assign-branch', incidentId, 'local')),
  ]);
  rows.push([
    button.callback('Органы исполнительной власти', incidentCallback('assign-branch', incidentId, 'executive')),
  ]);
  rows.push([button.callback('Отмена', incidentCallback('cancel', incidentId))]);
  return rows;
}

export function assignmentPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / ASSIGNMENT_PAGE_SIZE));
}

/** Second routing level: a paged list with the matching municipality first. */
export function assignmentGroupKeyboard(
  incidentId: string,
  branch: AssignmentBranch,
  groups: ResponsibleGroup[],
  page = 0,
  recommendedGroup: ResponsibleGroup | null = null,
): Button[][] {
  const ordered = recommendedGroup
    ? [recommendedGroup, ...groups.filter((group) => group.id !== recommendedGroup.id)]
    : groups;
  const pages = assignmentPageCount(ordered.length);
  const current = Math.min(Math.max(page, 0), pages - 1);
  const slice = ordered.slice(current * ASSIGNMENT_PAGE_SIZE, (current + 1) * ASSIGNMENT_PAGE_SIZE);
  const rows: Button[][] = slice.map((group) => {
    const recommended = group.id === recommendedGroup?.id;
    return [
      button.callback(
        recommended ? `⭐ ${group.name} — рекомендуется` : group.name,
        incidentCallback('assign-group', incidentId, group.id),
        { intent: recommended ? 'positive' : 'default' },
      ),
    ];
  });

  if (pages > 1) {
    const nav: Button[] = [];
    if (current > 0) {
      nav.push(
        button.callback(
          '⬅️ Назад',
          incidentCallback('assign-page', incidentId, `${branch}~${current - 1}`),
        ),
      );
    }
    nav.push(button.callback(`${current + 1} / ${pages}`, NOOP_CALLBACK));
    if (current < pages - 1) {
      nav.push(
        button.callback(
          'Вперёд ➡️',
          incidentCallback('assign-page', incidentId, `${branch}~${current + 1}`),
        ),
      );
    }
    rows.push(nav);
  }

  rows.push([button.callback('К выбору типа организации', incidentCallback('assign', incidentId))]);
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
export function reviewKeyboard(incidentId: string, answerId: string): Button[][] {
  return [
    [button.callback('✅ Согласовать', incidentCallback('approve', incidentId, answerId), { intent: 'positive' })],
    [button.callback('↩️ На доработку', incidentCallback('revision', incidentId, answerId), { intent: 'negative' })],
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
