import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Сферы обращений (§62).
 *
 * Codes are Latin and stable: they appear in admin commands and in history
 * metadata, so renaming a сфера must never change its code. Chat ids are set
 * per environment with `/category_chat <КОД> <CHAT_ID>` and are deliberately
 * absent here — a reseed must not wipe them.
 */
const CATEGORIES = [
  { code: 'SECURITY', name: 'Безопасность и правопорядок' },
  { code: 'IMPROVEMENT', name: 'Благоустройство' },
  { code: 'POLICY', name: 'Внутренняя политика' },
  { code: 'MILITARY', name: 'Военная служба' },
  { code: 'ROADS', name: 'Дороги' },
  { code: 'HEALTH', name: 'Здравоохранение' },
  { code: 'UTILITIES', name: 'ЖКХ' },
  { code: 'PROPERTY', name: 'Имущественные и земельные отношения' },
  { code: 'CULTURE', name: 'Культура' },
  { code: 'ETHNIC', name: 'Межнациональные отношения' },
  { code: 'YOUTH', name: 'Молодёжная политика' },
  { code: 'EDUCATION', name: 'Образование' },
  { code: 'WASTE', name: 'Обращение с отходами' },
  { code: 'TRANSPORT', name: 'Общественный транспорт' },
  { code: 'AUTHORITIES', name: 'Органы власти и подведомственные учреждения' },
  { code: 'TELECOM', name: 'Связь и телевидение' },
  { code: 'AGRICULTURE', name: 'Сельское хозяйство и охота' },
  { code: 'SOCIAL', name: 'Социальное обслуживание и защита' },
  { code: 'CONSTRUCTION', name: 'Строительство и архитектура' },
  { code: 'LABOR', name: 'Труд и занятость' },
  { code: 'TOURISM', name: 'Туризм' },
  { code: 'SPORT', name: 'Физическая культура и спорт' },
  { code: 'CUR', name: 'ЦУР' },
  { code: 'ECOLOGY', name: 'Экология' },
  { code: 'ECONOMY', name: 'Экономика и бизнес' },
  { code: 'ENERGY', name: 'Энергетика' },
];

async function main(): Promise<void> {
  for (const [index, category] of CATEGORIES.entries()) {
    await prisma.category.upsert({
      where: { code: category.code },
      create: {
        code: category.code,
        name: category.name,
        sortOrder: (index + 1) * 10,
        isActive: true,
      },
      // Name and ordering are safe to refresh; chat id, template and the
      // isActive flag are environment decisions and must survive a reseed.
      update: { name: category.name, sortOrder: (index + 1) * 10 },
    });
  }

  const total = await prisma.category.count();
  const withoutChat = await prisma.category.count({ where: { isActive: true, maxChatId: null } });
  process.stdout.write(`Seed complete. Сфер в базе: ${total}.\n`);
  if (withoutChat > 0) {
    process.stdout.write(
      `Без рабочего чата: ${withoutChat}. Задайте их командой /category_chat <КОД> <CHAT_ID>.\n`,
    );
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
