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
  { code: 'SECURITY', name: 'Безопасность и правопорядок', authorityName: null },
  { code: 'IMPROVEMENT', name: 'Благоустройство', authorityName: null },
  { code: 'POLICY', name: 'Внутренняя политика', authorityName: 'Министерство внутренней политики Калужской области' },
  { code: 'MILITARY', name: 'Военная служба', authorityName: null },
  { code: 'ROADS', name: 'Дороги', authorityName: 'Министерство транспорта Калужской области' },
  { code: 'HEALTH', name: 'Здравоохранение', authorityName: 'Министерство здравоохранения Калужской области' },
  { code: 'UTILITIES', name: 'ЖКХ', authorityName: 'Министерство строительства и жилищно-коммунального хозяйства Калужской области' },
  { code: 'PROPERTY', name: 'Имущественные и земельные отношения', authorityName: null },
  { code: 'CULTURE', name: 'Культура', authorityName: 'Министерство культуры и туризма Калужской области' },
  { code: 'ETHNIC', name: 'Межнациональные отношения', authorityName: null },
  { code: 'YOUTH', name: 'Молодёжная политика', authorityName: 'Управление молодёжной политики Калужской области' },
  { code: 'EDUCATION', name: 'Образование', authorityName: 'Министерство образования и науки Калужской области' },
  { code: 'WASTE', name: 'Обращение с отходами', authorityName: null },
  { code: 'TRANSPORT', name: 'Общественный транспорт', authorityName: 'Министерство транспорта Калужской области' },
  { code: 'AUTHORITIES', name: 'Органы власти и подведомственные учреждения', authorityName: null },
  { code: 'TELECOM', name: 'Связь и телевидение', authorityName: 'Министерство цифрового развития Калужской области' },
  { code: 'AGRICULTURE', name: 'Сельское хозяйство и охота', authorityName: null },
  { code: 'SOCIAL', name: 'Социальное обслуживание и защита', authorityName: 'Министерство труда и социальной защиты Калужской области' },
  { code: 'CONSTRUCTION', name: 'Строительство и архитектура', authorityName: 'Министерство строительства и жилищно-коммунального хозяйства Калужской области' },
  { code: 'LABOR', name: 'Труд и занятость', authorityName: 'Министерство труда и социальной защиты Калужской области' },
  { code: 'TOURISM', name: 'Туризм', authorityName: 'Министерство культуры и туризма Калужской области' },
  { code: 'SPORT', name: 'Физическая культура и спорт', authorityName: 'Министерство спорта Калужской области' },
  { code: 'CUR', name: 'ЦУР', authorityName: 'Центр управления регионом Калужской области' },
  { code: 'ECOLOGY', name: 'Экология', authorityName: 'Министерство природных ресурсов и экологии Калужской области' },
  { code: 'ECONOMY', name: 'Экономика и бизнес', authorityName: 'Министерство экономического развития и промышленности Калужской области' },
  { code: 'ENERGY', name: 'Энергетика', authorityName: null },
];

async function main(): Promise<void> {
  for (const [index, category] of CATEGORIES.entries()) {
    await prisma.category.upsert({
      where: { code: category.code },
      create: {
        code: category.code,
        name: category.name,
        authorityName: category.authorityName,
        sortOrder: (index + 1) * 10,
        isActive: true,
      },
      // Name and ordering are safe to refresh; chat id, template, authority
      // and the isActive flag are environment decisions edited in place by
      // administrators, so a reseed must never overwrite them.
      update: { name: category.name, sortOrder: (index + 1) * 10 },
    });
  }

  const total = await prisma.category.count();
  const withoutChat = await prisma.category.count({ where: { isActive: true, maxChatId: null } });
  const withoutAuthority = await prisma.category.count({
    where: { isActive: true, authorityName: null },
  });
  process.stdout.write(`Seed complete. Сфер в базе: ${total}.\n`);
  if (withoutAuthority > 0) {
    process.stdout.write(
      `Без ведомства для подписи: ${withoutAuthority}. Задайте: /category_authority <КОД> <Название>.\n`,
    );
  }
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
