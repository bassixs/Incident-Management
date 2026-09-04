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

  links(): LegalDocumentLinks {
    const base = this.config.LEGAL_DOCUMENTS_BASE_URL;
    if (!base) return {};
    return {
      userAgreement: `${base}/${LEGAL_FILE_NAMES.userAgreement}`,
      privacyPolicy: `${base}/${LEGAL_FILE_NAMES.privacyPolicy}`,
      personalDataConsent: `${base}/${LEGAL_FILE_NAMES.personalDataConsent}`,
    };
  }

  async status(userId: string): Promise<LegalAccessStatus> {
    if (!this.config.LEGAL_CONSENT_REQUIRED) {
      return {
        required: false,
        documentsAvailable: Boolean(this.config.LEGAL_DOCUMENTS_BASE_URL),
        agreementAccepted: true,
        consentAccepted: true,
        ready: true,
      };
    }

    const rows = await this.prisma.legalAcceptance.findMany({
      where: {
        userId,
        documentVersion: this.config.LEGAL_DOCUMENT_VERSION,
        OR: [
          {
            type: LegalAcceptanceType.USER_AGREEMENT,
            documentSha256: this.requireHash('LEGAL_USER_AGREEMENT_SHA256'),
          },
          {
            type: LegalAcceptanceType.PERSONAL_DATA_CONSENT,
            documentSha256: this.requireHash('LEGAL_PERSONAL_DATA_CONSENT_SHA256'),
          },
        ],
      },
      select: { type: true },
    });
    const accepted = new Set(rows.map((row) => row.type));
    const agreementAccepted = accepted.has(LegalAcceptanceType.USER_AGREEMENT);
    const consentAccepted = accepted.has(LegalAcceptanceType.PERSONAL_DATA_CONSENT);
    return {
      required: true,
      documentsAvailable: true,
      agreementAccepted,
      consentAccepted,
      ready: agreementAccepted && consentAccepted,
    };
  }

  async hasCurrentAccess(userId: string): Promise<boolean> {
    return (await this.status(userId)).ready;
  }

  async acceptUserAgreement(evidence: AcceptanceEvidence) {
    return this.accept(
      evidence,
      LegalAcceptanceType.USER_AGREEMENT,
      LEGAL_FILE_NAMES.userAgreement,
      this.requireHash('LEGAL_USER_AGREEMENT_SHA256'),
      LEGAL_CONFIRMATION_TEXT.userAgreement,
    );
  }

  async acceptPersonalDataConsent(evidence: AcceptanceEvidence) {
    const status = await this.status(evidence.userId);
    if (!status.required) throw new ValidationError('Подтверждение документов пока не требуется.');
    if (!status.agreementAccepted) {
      throw new ValidationError('Сначала примите Пользовательское соглашение.');
    }
    return this.accept(
      evidence,
      LegalAcceptanceType.PERSONAL_DATA_CONSENT,
      LEGAL_FILE_NAMES.personalDataConsent,
      this.requireHash('LEGAL_PERSONAL_DATA_CONSENT_SHA256'),
      LEGAL_CONFIRMATION_TEXT.personalDataConsent,
    );
  }

  private async accept(
    evidence: AcceptanceEvidence,
    type: LegalAcceptanceType,
    fileName: string,
    documentSha256: string,
    confirmationText: string,
  ) {
    if (!this.config.LEGAL_CONSENT_REQUIRED) {
      throw new ValidationError('Подтверждение документов пока не требуется.');
    }
    const base = this.config.LEGAL_DOCUMENTS_BASE_URL;
    if (!base) throw new Error('Legal document URL is not configured');

    return this.prisma.legalAcceptance.upsert({
      where: {
        userId_type_documentVersion: {
          userId: evidence.userId,
          type,
          documentVersion: this.config.LEGAL_DOCUMENT_VERSION,
        },
      },
      create: {
        userId: evidence.userId,
        maxUserId: evidence.maxUserId,
        type,
        documentVersion: this.config.LEGAL_DOCUMENT_VERSION,
        documentUrl: `${base}/${fileName}`,
        documentSha256,
        confirmationText,
        sourceCallbackId: evidence.sourceCallbackId ?? null,
        sourceMessageId: evidence.sourceMessageId ?? null,
        sourceChatId: evidence.sourceChatId ?? null,
      },
      update: {},
    });
  }

  private requireHash(
    key:
      | 'LEGAL_USER_AGREEMENT_SHA256'
      | 'LEGAL_PRIVACY_POLICY_SHA256'
      | 'LEGAL_PERSONAL_DATA_CONSENT_SHA256',
  ): string {
    const value = this.config[key];
    if (!value) throw new Error(`${key} is not configured`);
    return value.toLowerCase();
  }
}
