import { UserRole } from '@prisma/client';

import { getConfig } from '../config';

export { UserRole };

/**
 * Effective roles = roles stored on the User row ∪ roles listed in env.
 *
 * Roles live in the database from day one; the env lists exist so a fresh
 * deployment has working dispatchers before anyone can grant roles. Dropping
 * the env lists later changes nothing else in the codebase.
 */
export function resolveRoles(maxUserId: bigint, storedRoles: UserRole[] = []): UserRole[] {
  const config = getConfig();
  const roles = new Set<UserRole>(storedRoles);
  roles.add(UserRole.REQUESTER);
  if (config.ADMINS.some((id) => id === maxUserId)) roles.add(UserRole.ADMIN);
  if (config.DISPATCHERS.some((id) => id === maxUserId)) roles.add(UserRole.DISPATCHER);
  if (config.APPROVERS.some((id) => id === maxUserId)) roles.add(UserRole.APPROVER);
  if (config.RESPONDERS.some((id) => id === maxUserId)) roles.add(UserRole.RESPONDER);
  return [...roles];
}

export type Permission =
  | 'incident.distribute'
  | 'incident.reject'
  | 'incident.respond'
  | 'incident.approve'
  | 'user.ban'
  | 'report.generate'
  | 'incident.lookup'
  | 'delivery.manage'
  | 'admin.manage';

const PERMISSIONS: Record<Permission, UserRole[]> = {
  'incident.distribute': [UserRole.DISPATCHER, UserRole.ADMIN],
  'incident.reject': [UserRole.DISPATCHER, UserRole.ADMIN],
  'incident.respond': [UserRole.RESPONDER, UserRole.ADMIN],
  'incident.approve': [UserRole.APPROVER, UserRole.ADMIN],
  'user.ban': [UserRole.DISPATCHER, UserRole.ADMIN],
  'report.generate': [UserRole.DISPATCHER, UserRole.ADMIN],
  'incident.lookup': [UserRole.DISPATCHER, UserRole.RESPONDER, UserRole.APPROVER, UserRole.ADMIN],
  'admin.manage': [UserRole.ADMIN],
  'delivery.manage': [UserRole.ADMIN],
};

export function hasPermission(roles: UserRole[], permission: Permission): boolean {
  return PERMISSIONS[permission].some((role) => roles.includes(role));
}

export function isStaff(roles: UserRole[]): boolean {
  return roles.some((role) => role !== UserRole.REQUESTER);
}

export function describeRoles(roles: UserRole[]): string {
  return roles.length ? roles.join(', ') : UserRole.REQUESTER;
}
