import { IncidentStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { IncidentStateService } from '../../src/incidents/incident-state.service';
import { InvalidTransitionError } from '../../src/utils/errors';

const state = new IncidentStateService();

describe('IncidentStateService', () => {
  it('allows the happy path through the whole workflow', () => {
    expect(state.canTransition(IncidentStatus.NEW, IncidentStatus.DISTRIBUTION)).toBe(true);
    expect(state.canTransition(IncidentStatus.DISTRIBUTION, IncidentStatus.ASSIGNED)).toBe(true);
    expect(state.canTransition(IncidentStatus.ASSIGNED, IncidentStatus.IN_PROGRESS)).toBe(true);
    expect(state.canTransition(IncidentStatus.IN_PROGRESS, IncidentStatus.WAITING_REVIEW)).toBe(true);
    expect(state.canTransition(IncidentStatus.WAITING_REVIEW, IncidentStatus.RESOLVED)).toBe(true);
  });

  it('allows the revision loop', () => {
    expect(state.canTransition(IncidentStatus.WAITING_REVIEW, IncidentStatus.REVISION_REQUIRED)).toBe(true);
    expect(state.canTransition(IncidentStatus.REVISION_REQUIRED, IncidentStatus.IN_PROGRESS)).toBe(true);
    expect(state.canTransition(IncidentStatus.REVISION_REQUIRED, IncidentStatus.WAITING_REVIEW)).toBe(true);
  });

  it('allows a review-free group to complete an answer directly', () => {
    expect(state.canTransition(IncidentStatus.ASSIGNED, IncidentStatus.RESOLVED)).toBe(true);
    expect(state.canTransition(IncidentStatus.IN_PROGRESS, IncidentStatus.RESOLVED)).toBe(true);
  });

  it('allows rejection only from distribution', () => {
    expect(state.canTransition(IncidentStatus.DISTRIBUTION, IncidentStatus.REJECTED)).toBe(true);
    expect(state.canTransition(IncidentStatus.IN_PROGRESS, IncidentStatus.REJECTED)).toBe(false);
    expect(state.canTransition(IncidentStatus.WAITING_REVIEW, IncidentStatus.REJECTED)).toBe(false);
  });

  it('refuses arbitrary jumps', () => {
    expect(state.canTransition(IncidentStatus.DISTRIBUTION, IncidentStatus.RESOLVED)).toBe(false);
    expect(state.canTransition(IncidentStatus.NEW, IncidentStatus.WAITING_REVIEW)).toBe(false);
  });

  it('treats RESOLVED and REJECTED as terminal', () => {
    expect(state.allowedFrom(IncidentStatus.RESOLVED)).toEqual([]);
    expect(state.allowedFrom(IncidentStatus.REJECTED)).toEqual([]);
    expect(state.isTerminal(IncidentStatus.RESOLVED)).toBe(true);
    expect(state.isTerminal(IncidentStatus.REVISION_REQUIRED)).toBe(false);
  });

  it('throws a typed error on an illegal transition', () => {
    expect(() => state.assertTransition(IncidentStatus.RESOLVED, IncidentStatus.IN_PROGRESS)).toThrow(
      InvalidTransitionError,
    );
  });
});
