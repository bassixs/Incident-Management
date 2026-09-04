import {
  type PrismaClient,
  type ResponsibleGroup,
  ResponsibleGroupKind,
} from '@prisma/client';

import type { PrismaLike } from '../database/prisma';
import { NotFoundError, ValidationError } from '../utils/errors';

export class ResponsibleGroupService {
  constructor(private readonly prisma: PrismaClient) {}

  async listAll(): Promise<ResponsibleGroup[]> {
    return this.prisma.responsibleGroup.findMany({
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async listRoutable(kind: ResponsibleGroupKind, tx?: PrismaLike): Promise<ResponsibleGroup[]> {
    return (tx ?? this.prisma).responsibleGroup.findMany({
      where: { kind, isActive: true, maxChatId: { not: null } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async countActive(kind: ResponsibleGroupKind): Promise<number> {
    return this.prisma.responsibleGroup.count({ where: { kind, isActive: true } });
  }

  async findById(id: string, tx?: PrismaLike): Promise<ResponsibleGroup | null> {
    return (tx ?? this.prisma).responsibleGroup.findUnique({ where: { id } });
  }

  async findByCode(code: string): Promise<ResponsibleGroup | null> {
    return this.prisma.responsibleGroup.findUnique({ where: { code: code.toUpperCase() } });
  }

  async setChatId(code: string, maxChatId: bigint | null): Promise<ResponsibleGroup> {
    return this.prisma.responsibleGroup.update({
      where: { code: code.toUpperCase() },
      data: { maxChatId },
    });
  }

  async setActive(code: string, isActive: boolean): Promise<ResponsibleGroup> {
    return this.prisma.responsibleGroup.update({
      where: { code: code.toUpperCase() },
      data: { isActive },
    });
  }

  async rename(code: string, name: string): Promise<ResponsibleGroup> {
    return this.prisma.responsibleGroup.update({
      where: { code: code.toUpperCase() },
      data: { name },
    });
  }

  async setAuthority(code: string, authorityName: string | null): Promise<ResponsibleGroup> {
    return this.prisma.responsibleGroup.update({
      where: { code: code.toUpperCase() },
      data: { authorityName },
    });
  }

  async setTemplate(code: string, answerTemplate: string | null): Promise<ResponsibleGroup> {
    return this.prisma.responsibleGroup.update({
      where: { code: code.toUpperCase() },
      data: { answerTemplate },
    });
  }

  async findByMunicipalityCode(code: string | null | undefined): Promise<ResponsibleGroup | null> {
    if (!code) return null;
    return this.prisma.responsibleGroup.findUnique({ where: { municipalityCode: code } });
  }

  async requireActiveById(id: string, tx?: PrismaLike): Promise<ResponsibleGroup> {
    const group = await this.findById(id, tx);
    if (!group) throw new NotFoundError(`Responsible group ${id} not found`);
    if (!group.isActive) throw new ValidationError(`Группа «${group.name}» отключена.`);
    return group;
  }

  requireChatId(group: ResponsibleGroup): bigint {
    if (group.maxChatId === null) {
      throw new ValidationError(`Для группы «${group.name}» не настроен рабочий чат.`);
    }
    return group.maxChatId;
  }
}
