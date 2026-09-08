import { describe, expect, it } from 'vitest';

import {
  agreementAcceptanceKeyboard,
  legalDocumentsKeyboard,
  mainMenuKeyboard,
  personalDataConsentKeyboard,
} from '../../src/bot/keyboards';
import { parseCallbackPayload } from '../../src/max/callback-payload';

function callbackOf(rows: ReturnType<typeof legalDocumentsKeyboard>, label: string): string | undefined {
  const item = rows.flat().find((button) => button.text === label);
  return item && 'payload' in item ? item.payload : undefined;
}

describe('legal document keyboards', () => {
  const links = {
    userAgreement: 'https://example.test/documents/user-agreement.pdf',
    privacyPolicy: 'https://example.test/documents/privacy-policy.pdf',
    personalDataConsent: 'https://example.test/documents/personal-data-consent.pdf',
  };

  it('keeps the document centre permanently visible in the main menu', () => {
    expect(mainMenuKeyboard().flat().map((button) => button.text)).toContain('📄 Документы');
  });

  it('shows three HTTPS documents and accepts the agreement directly', () => {
    const keyboard = legalDocumentsKeyboard(links, { acceptance: 'agreement' });
    const urls = keyboard
      .flat()
      .filter((button) => button.type === 'link')
      .map((button) => ('url' in button ? button.url : undefined));
    expect(urls).toEqual(Object.values(links));
    expect(parseCallbackPayload(callbackOf(keyboard, 'Принимаю пользовательское соглашение'))).toEqual({
      kind: 'user',
      action: 'accept-agreement',
    });
    expect(callbackOf(keyboard, 'Продолжить')).toBeUndefined();
    expect(callbackOf(keyboard, 'Даю согласие на обработку персональных данных')).toBeUndefined();
  });

  it('offers only the remaining consent when the agreement is already accepted', () => {
    const keyboard = legalDocumentsKeyboard(links, { acceptance: 'consent' });
    expect(parseCallbackPayload(callbackOf(keyboard, 'Даю согласие на обработку персональных данных')))
      .toEqual({ kind: 'user', action: 'accept-consent' });
    expect(callbackOf(keyboard, 'Принимаю пользовательское соглашение')).toBeUndefined();
  });

  it('uses two different explicit confirmation buttons', () => {
    const agreementPayload = callbackOf(
      agreementAcceptanceKeyboard(links.userAgreement),
      'Принимаю пользовательское соглашение',
    );
    const consentPayload = callbackOf(
      personalDataConsentKeyboard(links.personalDataConsent),
      'Даю согласие на обработку персональных данных',
    );
    expect(parseCallbackPayload(agreementPayload)).toEqual({ kind: 'user', action: 'accept-agreement' });
    expect(parseCallbackPayload(consentPayload)).toEqual({ kind: 'user', action: 'accept-consent' });
    expect(agreementPayload).not.toBe(consentPayload);
  });

  it('does not invent links while documents are unpublished', () => {
    const keyboard = legalDocumentsKeyboard({});
    expect(keyboard.flat().some((button) => button.type === 'link')).toBe(false);
  });
});
