import { UserRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { getConfig } from '../../src/config';
import type { IncidentWithRelations } from '../../src/incidents/incident.repository';
import {
  assertApprover,
  assertDispatcher,
  assertResponder,
  assertWorkingChat,
  requirePermission,
} from '../../src/bot/middleware/authorize';
import type { ResolvedActor } from '../../src/bot/handlers/helpers';
import { hasPermission, resolveRoles } from '../../src/users/roles';
import { ForbiddenError } from '../../src/utils/errors';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

function actor(maxUserId: bigint, roles: UserRole[]): ResolvedActor {
  return {
    userId: `user-${maxUserId}`,
    maxUserId,
    displayName: `User ${maxUserId}`,
    role: roles.join('|'),
    roles,
  };
}

const services = { config: getConfig() } as never;

const requester = actor(TEST_USERS.requesterA, [UserRole.REQUESTER]);
const dispatcher = actor(TEST_USERS.dispatcher, [UserRole.REQUESTER, UserRole.DISPATCHER]);
const approver = actor(TEST_USERS.approver, [UserRole.REQUESTER, UserRole.APPROVER]);
const responder = actor(TEST_USERS.responder, [UserRole.REQUESTER, UserRole.RESPONDER]);
const admin = actor(TEST_USERS.admin, [UserRole.REQUESTER, UserRole.ADMIN]);

const incident = {
  publicCode: 'INC-20260823-0001',
  assignedGroup: { maxChatId: TEST_CHATS.sector },
} as unknown as IncidentWithRelations;

const regionalIncident = {
  publicCode: 'INC-20260823-0002',
  assignedGroup: { maxChatId: TEST_CHATS.regional, bypassReview: true },
} as unknown as IncidentWithRelations;

describe('role resolution', () => {
  it('merges env-provided roles with stored ones and always adds REQUESTER', () => {
    expect(resolveRoles(TEST_USERS.dispatcher, [])).toContain(UserRole.DISPATCHER);
    expect(resolveRoles(TEST_USERS.admin, [])).toContain(UserRole.ADMIN);
    expect(resolveRoles(TEST_USERS.requesterA, [])).toEqual([UserRole.REQUESTER]);
    expect(resolveRoles(TEST_USERS.requesterA, [UserRole.RESPONDER])).toEqual(
      expect.arrayContaining([UserRole.RESPONDER, UserRole.REQUESTER]),
    );
  });

  it('gives an admin every permission', () => {
    for (const permission of [
      'incident.distribute',
      'incident.approve',
      'incident.respond',
      'user.ban',
      'report.generate',
      'admin.manage',
    ] as const) {
      expect(hasPermission([UserRole.ADMIN], permission)).toBe(true);
    }
  });
});

describe('dispatcher actions', () => {
  it('are refused for a requester (§61 security)', () => {
    expect(() => assertDispatcher(services, requester, TEST_CHATS.distribution)).toThrow(ForbiddenError);
  });

  it('are refused outside the distribution chat', () => {
    expect(() => assertDispatcher(services, dispatcher, TEST_CHATS.sector)).toThrow(ForbiddenError);
    expect(() => assertDispatcher(services, dispatcher, undefined)).toThrow(ForbiddenError);
  });

  it('are allowed for a dispatcher in the distribution chat', () => {
    expect(() => assertDispatcher(services, dispatcher, TEST_CHATS.distribution)).not.toThrow();
  });
});

describe('approver actions', () => {
  it('are refused for a responder without the approve permission', () => {
    expect(() => assertApprover(services, responder, TEST_CHATS.review)).toThrow(ForbiddenError);
  });

  it('are refused in the wrong chat even for an approver', () => {
    expect(() => assertApprover(services, approver, TEST_CHATS.distribution)).toThrow(ForbiddenError);
  });

  it('are allowed for an approver in the review chat', () => {
    expect(() => assertApprover(services, approver, TEST_CHATS.review)).not.toThrow();
  });
});

describe('responder actions', () => {
  it('are bound to the incident own sector chat', () => {
    expect(() => assertResponder(responder, incident, TEST_CHATS.sector)).not.toThrow();
    expect(() => assertResponder(responder, incident, TEST_CHATS.otherSector)).toThrow(ForbiddenError);
    expect(() => assertResponder(requester, incident, TEST_CHATS.otherSector)).toThrow(ForbiddenError);
  });

  it('are refused when the responsible group has no chat configured', () => {
    const unrouted = { publicCode: 'INC-1', assignedGroup: null } as unknown as IncidentWithRelations;
    expect(() => assertResponder(responder, unrouted, TEST_CHATS.sector)).toThrow(ForbiddenError);
  });

  it('let an admin act from anywhere', () => {
    expect(() => assertResponder(admin, incident, TEST_CHATS.otherSector)).not.toThrow();
  });

  it('allows only dispatchers to answer in the Kaluga Region chat', () => {
    expect(() => assertResponder(dispatcher, regionalIncident, TEST_CHATS.regional)).not.toThrow();
    expect(() => assertResponder(responder, regionalIncident, TEST_CHATS.regional)).toThrow(ForbiddenError);
  });
});

describe('working-chat commands', () => {
  it('are refused in a private dialog', () => {
    expect(() => assertWorkingChat(true)).toThrow(ForbiddenError);
    expect(() => assertWorkingChat(false)).not.toThrow();
  });

  it('do not leak the reason for a denial', () => {
    try {
      requirePermission(requester, 'report.generate');
    } catch (error) {
      expect((error as ForbiddenError).message).toBe('У вас нет прав для этого действия.');
    }
  });
});
