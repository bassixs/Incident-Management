import type { PrismaClient, User } from '@prisma/client';
import type { MaxUser } from '../max/max-types';

import type { PrismaLike } from '../database/prisma';
import { NotFoundError } from '../utils/errors';
import { resolveRoles, type Permission, type UserRole, hasPermission } from './roles';

export type ActorIdentity = {
  user: User;
  roles: UserRole[];
};

export class UserService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Upsert the MAX profile we saw on this update.
   *
   * Every incident points at a User row, so the requester identity survives
   * even if the person later changes their display name.
   */
  async upsertFromMax(maxUser: Pick<MaxUser, 'user_id' | 'name' | 'username'>, tx?: PrismaLike): Promise<User> {
    const client = tx ?? this.prisma;
    const maxUserId = BigInt(maxUser.user_id);
    const displayName = maxUser.name?.trim() || `User ${maxUser.user_id}`;
    return client.user.upsert({
      where: { maxUserId },
      create: { maxUserId, displayName, username: maxUser.username ?? null },
      update: { displayName, username: maxUser.username ?? null },
    });
  }

  async findByMaxId(maxUserId: bigint, tx?: PrismaLike): Promise<User | null> {
    return (tx ?? this.prisma).user.findUnique({ where: { maxUserId } });
  }

  async requireByMaxId(maxUserId: bigint, tx?: PrismaLike): Promise<User> {
    const user = await this.findByMaxId(maxUserId, tx);
    if (!user) throw new NotFoundError(`User ${maxUserId.toString()} is unknown to the bot`);
    return user;
  }

  async saveRequesterProfile(
    maxUserId: bigint,
    requesterName: string,
    requesterPhone: string,
    tx?: PrismaLike,
  ): Promise<User> {
    return (tx ?? this.prisma).user.update({
      where: { maxUserId },
      data: { requesterName, requesterPhone },
    });
  }

  async identity(maxUser: Pick<MaxUser, 'user_id' | 'name' | 'username'>): Promise<ActorIdentity> {
    const user = await this.upsertFromMax(maxUser);
    return { user, roles: resolveRoles(user.maxUserId, user.roles) };
  }

  async rolesOf(maxUserId: bigint): Promise<UserRole[]> {
    const user = await this.findByMaxId(maxUserId);
    return resolveRoles(maxUserId, user?.roles ?? []);
  }

  async can(maxUserId: bigint, permission: Permission): Promise<boolean> {
    return hasPermission(await this.rolesOf(maxUserId), permission);
  }

  async setRoles(maxUserId: bigint, roles: UserRole[]): Promise<User> {
    return this.prisma.user.update({ where: { maxUserId }, data: { roles } });
  }
}
