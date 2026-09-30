import { createHmac, timingSafeEqual } from 'node:crypto';
import { normaliseRequesterPhone } from '../incidents/incident.service';

export const OPTIONAL_PHONE_OFFER = 'Для более оперативной обработки можно поделиться телефоном. Это необязательно.';
export const OPTIONAL_PHONE_ADDED = 'Специалист сможет связаться с вами для уточнения деталей';

/** Trusted, minimal inbox extension. Never contains the original contact or signature. */
export type VerifiedDraftContact = { phone: string; draftToken: string; previewToken: string };

/** MAX documents HMAC-SHA256(bot token, VCF). SDK 0.2.5 omits hash/max_info in its types. */
export function verifyOwnContact(payload: unknown, senderId: number, botToken: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { vcf_info?: unknown; hash?: unknown; max_info?: { user_id?: unknown }; tam_info?: { user_id?: unknown } };
  const id = p.max_info?.user_id ?? p.tam_info?.user_id;
  if (!Number.isSafeInteger(senderId) || id !== senderId || typeof p.vcf_info !== 'string' || p.vcf_info.length > 8192 || typeof p.hash !== 'string') return null;
  // JSON normally already decodes CRLF; handle the documented double-escaped form too.
  const vcf = p.vcf_info.replace(/\\r\\n/g, '\r\n');
  const expected = createHmac('sha256', botToken).update(vcf, 'utf8').digest();
  const supplied = /^[a-f\d]{64}$/i.test(p.hash) ? Buffer.from(p.hash, 'hex')
    : /^[A-Za-z\d+/_-]{43}=?$/.test(p.hash) ? Buffer.from(p.hash, 'base64') : null;
  if (!supplied || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  const phones = [...vcf.matchAll(/^TEL(?:;[^:\r\n]*)?:([^\r\n]+)$/gmi)];
  if (phones.length !== 1) return null;
  try { return normaliseRequesterPhone(phones[0]![1]!.replace(/^tel:/i, '')); } catch { return null; }
}
