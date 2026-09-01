import type { Category, PrismaClient } from '@prisma/client';

import type { PrismaLike } from '../database/prisma';
import { NotFoundError, ValidationError } from '../utils/errors';

/**
 * Categories (сферы) are data, never code.
 *
 * Nothing in the handlers may branch on a hardcoded category code: keyboards
 * are built from this table and callbacks carry category ids, so adding a
 * seventh sector is an INSERT, not a deployment.
 */
export class CategoryService {
  constructor(private readonly prisma: PrismaClient) {}

  async listActive(tx?: PrismaLike): Promise<Category[]> {
    return (tx ?? this.prisma).category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async listAll(): Promise<Category[]> {
    return this.prisma.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  }

  /**
   * Сферы an incident can actually be routed to.
   *
   * A сфера without a working chat has nowhere to publish the card, so it is
   * never offered to a dispatcher — better an absent button than a button that
   * fails after the click.
   */
  async listRoutable(tx?: PrismaLike): Promise<Category[]> {
    return (tx ?? this.prisma).category.findMany({
      where: { isActive: true, maxChatId: { not: null } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async findById(id: string, tx?: PrismaLike): Promise<Category | null> {
    return (tx ?? this.prisma).category.findUnique({ where: { id } });
  }

  async requireById(id: string, tx?: PrismaLike): Promise<Category> {
    const category = await this.findById(id, tx);
    if (!category) throw new NotFoundError(`Category ${id} not found`);
    return category;
  }

  async findByCode(code: string): Promise<Category | null> {
    return this.prisma.category.findUnique({ where: { code: code.toUpperCase() } });
  }

  async requireActiveById(id: string, tx?: PrismaLike): Promise<Category> {
    const category = await this.requireById(id, tx);
    if (!category.isActive) throw new ValidationError(`Category ${category.name} is disabled`);
    return category;
  }

  async create(input: {
    code: string;
    name: string;
    maxChatId?: bigint | null;
    answerTemplate?: string | null;
    sortOrder?: number;
  }): Promise<Category> {
    return this.prisma.category.create({
      data: {
        code: input.code.toUpperCase(),
        name: input.name,
        maxChatId: input.maxChatId ?? null,
        answerTemplate: input.answerTemplate ?? null,
        sortOrder: input.sortOrder ?? 100,
      },
    });
  }

  async setChatId(code: string, maxChatId: bigint | null): Promise<Category> {
    return this.prisma.category.update({
      where: { code: code.toUpperCase() },
      data: { maxChatId },
    });
  }

  async setActive(code: string, isActive: boolean): Promise<Category> {
    return this.prisma.category.update({ where: { code: code.toUpperCase() }, data: { isActive } });
  }

  /** Display name only; the code stays fixed so history and commands survive. */
  async rename(code: string, name: string): Promise<Category> {
    return this.prisma.category.update({ where: { code: code.toUpperCase() }, data: { name } });
  }

  /**
   * Official body that signs answers for this сфера.
   * `null` clears it, and an unset authority simply omits the signature.
   */
  async setAuthority(code: string, authorityName: string | null): Promise<Category> {
    return this.prisma.category.update({
      where: { code: code.toUpperCase() },
      data: { authorityName },
    });
  }

  async setTemplate(code: string, answerTemplate: string | null): Promise<Category> {
    return this.prisma.category.update({ where: { code: code.toUpperCase() }, data: { answerTemplate } });
  }

  /** The chat a distributed incident must be published to. */
  requireChatId(category: Category): bigint {
    if (category.maxChatId === null) {
      throw new ValidationError(
        `Для сферы «${category.name}» не настроен рабочий чат. Задайте его командой /category_chat ${category.code} <CHAT_ID>.`,
      );
    }
    return category.maxChatId;
  }
}
