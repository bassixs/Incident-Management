import { LegalAcceptanceType, type PrismaClient } from '@prisma/client';

import type { AppConfig } from '../config';
import { ValidationError } from '../utils/errors';

export const LEGAL_FILE_NAMES = {
  userAgreement: 'user-agreement.pdf',
  privacyPolicy: 'privacy-policy.pdf',
  personalDataConsent: 'personal-data-consent.pdf',
} as const;

export const LEGAL_CONFIRMATION_TEXT = {
  userAgreement: 'Принимаю пользовательское соглашение',
  personalDataConsent: 'Даю согласие на обработку персональных данных',
} as const;

export type LegalDocumentLinks = {
  userAgreement?: string;
  privacyPolicy?: string;
  personalDataConsent?: string;
};

export type LegalAccessStatus = {
  required: boolean;
  documentsAvailable: boolean;
  agreementAccepted: boolean;
  consentAccepted: boolean;
  ready: boolean;
};

type AcceptanceEvidence = {
  userId: string;
  maxUserId: bigint;
  sourceCallbackId?: string;
  sourceMessageId?: string;
  sourceChatId?: bigint;
};

export class LegalAcceptanceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig,
  ) {}

  get agreementVersion(): string {
    return this.config.LEGAL_USER_AGREEMENT_VERSION ?? this.config.LEGAL_DOCUMENT_VERSION;
  }

  links(): LegalDocumentLinks {
    const base = this.config.LEGAL_DOCUMENTS_BASE_URL;
    if (!base) return {};
    return {
      userAgreement: `${base}/${LEGAL_FILE_NAMES.userAgreement}`,
      privacyPolicy: `${base}/${LEGAL_FILE_NAMES.privacyPolicy}`,
      personalDataConsent: `${base}/${LEGAL_FILE_NAMES.personalDataConsent}`,
    };
  }

  async status(_userId: string): Promise<LegalAccessStatus> {
    return { required: false, documentsAvailable: !!this.config.LEGAL_DOCUMENTS_BASE_URL,
      agreementAccepted: false, consentAccepted: false, ready: true };
  }

  async hasCurrentAccess(_userId: string): Promise<boolean> { return true; }

  async acceptUserAgreement(_evidence: AcceptanceEvidence): Promise<never> {
    throw new ValidationError('Подтверждение документов отключено.');
  }

  async acceptPersonalDataConsent(_evidence: AcceptanceEvidence): Promise<never> {
    throw new ValidationError('Подтверждение документов отключено.');
  }
}
