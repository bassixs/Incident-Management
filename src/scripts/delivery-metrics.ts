import { PrismaClient } from '@prisma/client';
import { deliveryMetrics } from '../reports/delivery-metrics';
import 'dotenv/config';

async function main() {
  const [fromArg, toArg, ...extra] = process.argv.slice(2);
  if (extra.length || [fromArg, toArg].some(value => value && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))) {
    throw new Error('Укажите начало и конец в ISO 8601 с часовым поясом, например 2026-09-09T08:00:00+03:00. Без аргументов: последние 24 часа.');
  }
  const to = toArg ? new Date(toArg) : new Date();
  const from = fromArg ? new Date(fromArg) : new Date(to.getTime() - 86_400_000);
  const prisma = new PrismaClient();
  try { console.log(JSON.stringify(await deliveryMetrics(prisma, from, to), null, 2)); }
  finally { await prisma.$disconnect(); }
}
main().catch(() => { console.error('Не удалось получить метрики. Проверьте период ISO 8601 с часовым поясом и подключение к базе.'); process.exitCode = 1; });
