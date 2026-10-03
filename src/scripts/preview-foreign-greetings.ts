import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { getConfig } from '../config';
import { previewGreetingRetirement } from '../maintenance/foreign-greeting-retirement';

/** Inputs and output contain operational IDs: keep them private and outside Git.
 * Usage: node dist/scripts/preview-foreign-greetings.js ids.json new-private-directory */
async function main(): Promise<void> {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw new Error('Expected input and a new private output directory');
  const ids: unknown = JSON.parse(await readFile(input, 'utf8'));
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Expected an array of full UUIDs');
  const prisma = new PrismaClient();
  try {
    const result = await previewGreetingRetirement({ prisma, config: getConfig() }, ids);
    await mkdir(output, { mode: 0o700 }); // Fail instead of overwriting a previous review.
    await writeFile(path.join(output, 'preview.json'), JSON.stringify({ at: new Date().toISOString(), jobs: result.jobs }, null, 2), { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(output, 'retire.sql'), result.sql, { mode: 0o600, flag: 'wx' });
    console.log(`Preview prepared for ${result.jobs.length} jobs. No updates or MAX requests were executed.`);
  } finally { await prisma.$disconnect(); }
}
main().catch(() => { console.error('PREVIEW_REFUSED: verify explicit IDs, unchanged greeting/type/origin, MAX 403, delivery state and current work-chat bindings. No changes applied.'); process.exitCode = 1; });
