/**
 * Structured callback payloads.
 *
 * Rules:
 *  * никогда free text - only a fixed verb plus opaque ids;
 *  * the payload is a *routing hint only*. Every handler re-loads the incident
 *    from the database and re-checks status, role and chat before acting.
 */

export const INCIDENT_ACTIONS = [
  'assign',
  'assign-branch',
  'assign-page',
  'assign-group',
  'assign-category',
  'reject',
  'ban',
  'take',
  'answer',
  'clarify',
  'clarify-send',
  'clarify-cancel',
  'template',
  'approve',
  'revision',
  'fix',
  'repair-photo',
  'cancel',
] as const;

export type IncidentAction = (typeof INCIDENT_ACTIONS)[number];

export const USER_ACTIONS = [
  'new',
  'category',
  'page',
  'location-page',
  'municipality',
  'locality',
  'my-incidents',
  'rules',
  'documents',
  'legal-continue',
  'accept-agreement',
  'accept-consent',
  'draft-confirm',
  'draft-edit',
  'draft-field',
  'draft-photo',
  'rate-answer',
  'clarify-reply',
  'menu',
] as const;
export type UserAction = (typeof USER_ACTIONS)[number];

export const SESSION_ACTIONS = ['continue', 'cancel'] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

/** Period buttons under `/report`; `custom` asks the operator to type dates. */
export const REPORT_ACTIONS = ['today', '7d', '30d', 'month', 'all', 'custom'] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];

export type CallbackPayload =
  | { kind: 'work'; action: 'next' | 'list' | 'mine' | 'today' | 'refresh' | 'open' | 'release'; argument?: string }
  | { kind: 'cleanup'; action: 'today' | '7d' | '30d' | '90d' | 'all' | 'custom' }
  | { kind: 'help'; action: 'guide' | 'admin' }
  | { kind: 'queue'; action: 'next' | 'list' | 'refresh' | 'open' | 'release'; argument?: string }
  | { kind: 'incident'; action: IncidentAction; incidentId: string; argument?: string }
  | { kind: 'user'; action: UserAction; argument?: string }
  | { kind: 'session'; action: SessionAction }
  | { kind: 'report'; action: ReportAction }
  | { kind: 'noop' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function incidentCallback(action: IncidentAction, incidentId: string, argument?: string): string {
  return argument === undefined
    ? `incident:${action}:${incidentId}`
    : `incident:${action}:${incidentId}:${argument}`;
}

export function userCallback(action: UserAction, argument?: string): string {
  return argument === undefined ? `user:${action}` : `user:${action}:${argument}`;
}

export function sessionCallback(action: SessionAction): string {
  return `session:${action}`;
}

export function reportCallback(action: ReportAction): string {
  return `report:${action}`;
}

export const NOOP_CALLBACK = 'noop';

/** Returns null for anything malformed; callers answer with a generic notice. */
export function parseCallbackPayload(raw: string | undefined | null): CallbackPayload | null {
  if (!raw) return null;
  if (raw === NOOP_CALLBACK) return { kind: 'noop' };

  const parts = raw.split(':');
  const [namespace, action, ...rest] = parts;
  if (namespace === 'work') {
    if (rest.length > 1) return null;
    const argument = rest[0];
    if ((action === 'next' || action === 'refresh') && argument === undefined) return { kind: 'work', action };
    if (action && ['list', 'mine', 'today'].includes(action) && argument !== undefined && /^\d{1,6}$/.test(argument)) return { kind: 'work', action: action as 'list' | 'mine' | 'today', argument };
    if ((action === 'open' || action === 'release') && argument && isUuid(argument)) return { kind: 'work', action, argument };
    return null;
  }

  if (namespace === 'cleanup') {
    return rest.length === 0 && action && ['today', '7d', '30d', '90d', 'all', 'custom'].includes(action)
      ? { kind: 'cleanup', action: action as Extract<CallbackPayload, { kind: 'cleanup' }>['action'] } : null;
  }

  if (namespace === 'help') {
    return rest.length === 0 && (action === 'guide' || action === 'admin') ? { kind: 'help', action } : null;
  }

  if (namespace === 'queue') {
    if (rest.length > 1) return null;
    const argument = rest[0];
    if (action === 'next' || action === 'refresh') return argument === undefined ? { kind: 'queue', action } : null;
    if (action === 'list' && argument !== undefined && /^\d{1,6}$/.test(argument)) return { kind: 'queue', action, argument };
    if ((action === 'open' || action === 'release') && argument && isUuid(argument)) return { kind: 'queue', action, argument };
    return null;
  }

  if (namespace === 'incident') {
    if (!action || !INCIDENT_ACTIONS.includes(action as IncidentAction)) return null;
    const incidentId = rest[0];
    if (!incidentId || !isUuid(incidentId)) return null;
    const argument = rest[1];
    return {
      kind: 'incident',
      action: action as IncidentAction,
      incidentId,
      ...(argument === undefined ? {} : { argument }),
    };
  }

  if (namespace === 'user') {
    if (!action || !USER_ACTIONS.includes(action as UserAction)) return null;
    const argument = rest[0];
    return { kind: 'user', action: action as UserAction, ...(argument === undefined ? {} : { argument }) };
  }

  if (namespace === 'session') {
    if (!action || !SESSION_ACTIONS.includes(action as SessionAction)) return null;
    return { kind: 'session', action: action as SessionAction };
  }

  if (namespace === 'report') {
    if (!action || !REPORT_ACTIONS.includes(action as ReportAction)) return null;
    return { kind: 'report', action: action as ReportAction };
  }

  return null;
}
