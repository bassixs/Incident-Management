import { describe, expect, it } from 'vitest';

import {
  incidentCallback,
  parseCallbackPayload,
  reportCallback,
  sessionCallback,
  userCallback,
} from '../../src/max/callback-payload';

const INCIDENT_ID = '550e8400-e29b-41d4-a716-446655440000';
const CATEGORY_ID = '11111111-2222-3333-4444-555555555555';

describe('callback payloads', () => {
  it('round-trips every incident action', () => {
    expect(incidentCallback('assign', INCIDENT_ID)).toBe(`incident:assign:${INCIDENT_ID}`);
    expect(parseCallbackPayload(incidentCallback('approve', INCIDENT_ID))).toEqual({
      kind: 'incident',
      action: 'approve',
      incidentId: INCIDENT_ID,
    });
  });

  it('carries a category id as a separate segment', () => {
    const raw = incidentCallback('assign-category', INCIDENT_ID, CATEGORY_ID);
    expect(raw).toBe(`incident:assign-category:${INCIDENT_ID}:${CATEGORY_ID}`);
    expect(parseCallbackPayload(raw)).toEqual({
      kind: 'incident',
      action: 'assign-category',
      incidentId: INCIDENT_ID,
      argument: CATEGORY_ID,
    });
  });

  it('round-trips user and session payloads', () => {
    expect(parseCallbackPayload(userCallback('category', 'none'))).toEqual({
      kind: 'user',
      action: 'category',
      argument: 'none',
    });
    expect(parseCallbackPayload(sessionCallback('cancel'))).toEqual({ kind: 'session', action: 'cancel' });
  });

  it('round-trips report period buttons', () => {
    expect(parseCallbackPayload(reportCallback('month'))).toEqual({ kind: 'report', action: 'month' });
    expect(parseCallbackPayload(reportCallback('custom'))).toEqual({ kind: 'report', action: 'custom' });
    expect(parseCallbackPayload('report:lastyear')).toBeNull();
  });

  it('rejects free text, unknown verbs and malformed ids', () => {
    expect(parseCallbackPayload('drop table incidents')).toBeNull();
    expect(parseCallbackPayload('incident:delete:' + INCIDENT_ID)).toBeNull();
    expect(parseCallbackPayload('incident:approve:not-a-uuid')).toBeNull();
    expect(parseCallbackPayload('incident:approve')).toBeNull();
    expect(parseCallbackPayload('other:approve:' + INCIDENT_ID)).toBeNull();
    expect(parseCallbackPayload(undefined)).toBeNull();
    expect(parseCallbackPayload('')).toBeNull();
  });

  it('keeps payloads well under the MAX button payload budget', () => {
    expect(incidentCallback('assign-category', INCIDENT_ID, CATEGORY_ID).length).toBeLessThan(256);
  });
});
