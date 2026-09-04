import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config';

const BASE_ENV = {
  NODE_ENV: 'test',
  BOT_TOKEN: 'test-token',
  DATABASE_URL: 'postgresql://incident:incident@localhost:5432/incident_test',
  BOT_MODE: 'polling',
};

describe('legal consent configuration', () => {
  it('stays disabled by default while documents are drafts', () => {
    expect(loadConfig(BASE_ENV).LEGAL_CONSENT_REQUIRED).toBe(false);
  });

  it('refuses to enable the gate without every published document fingerprint', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        LEGAL_CONSENT_REQUIRED: 'true',
        LEGAL_DOCUMENTS_BASE_URL: 'https://example.test/documents',
      }),
    ).toThrow('LEGAL_USER_AGREEMENT_SHA256');
  });

  it('accepts a complete publication configuration and normalises the base URL', () => {
    const hash = 'a'.repeat(64);
    const config = loadConfig({
      ...BASE_ENV,
      LEGAL_CONSENT_REQUIRED: 'true',
      LEGAL_DOCUMENTS_BASE_URL: 'https://example.test/documents/',
      LEGAL_DOCUMENT_VERSION: '1.0',
      LEGAL_USER_AGREEMENT_SHA256: hash,
      LEGAL_PRIVACY_POLICY_SHA256: hash,
      LEGAL_PERSONAL_DATA_CONSENT_SHA256: hash,
    });
    expect(config.LEGAL_DOCUMENTS_BASE_URL).toBe('https://example.test/documents');
    expect(config.LEGAL_DOCUMENT_VERSION).toBe('1.0');
  });
});
