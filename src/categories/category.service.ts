import type { Category, PrismaClient } from '@prisma/client';

import type { PrismaLike } from '../database/prisma';
import { NotFoundError, ValidationError } from '../utils/errors';

/**
 * Requester-facing topics are data, never code. They do not route incidents;
 * operational destinations live in ResponsibleGroup.
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
    sortOrder?: number;
  }): Promise<Category> {
    return this.prisma.category.create({
      data: {
        code: input.code.toUpperCase(),
        name: input.name,
        sortOrder: input.sortOrder ?? 100,
      },
    });
  }

  async setActive(code: string, isActive: boolean): Promise<Category> {
    return this.prisma.category.update({ where: { code: code.toUpperCase() }, data: { isActive } });
  }

  /** Display name only; the code stays fixed so history and commands survive. */
  async rename(code: string, name: string): Promise<Category> {
    return this.prisma.category.update({ where: { code: code.toUpperCase() }, data: { name } });
  }

}
