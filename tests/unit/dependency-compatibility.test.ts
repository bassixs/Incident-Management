import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { loadConfigFromFile } from '@prisma/config';
import ExcelJS from 'exceljs';
import { expect, it } from 'vitest';

it('loads Prisma configuration through the updated deepmerge dependency', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'incident-prisma-config-'));
  try {
    await writeFile(path.join(directory, 'prisma.config.cjs'), `module.exports = {
      schema: 'schema.prisma',
      migrations: { path: 'migrations', seed: 'node seed.js' }
    };`);
    const loaded = await loadConfigFromFile({ configRoot: directory });
    expect(loaded.error).toBeUndefined();
    expect(loaded.config?.schema).toBe(path.join(directory, 'schema.prisma'));
    expect(loaded.config?.migrations).toMatchObject({
      path: path.join(directory, 'migrations'), seed: 'node seed.js',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('round-trips an Excel workbook through the formatting path that uses uuid', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Проверка');
  sheet.addRows([[1], [2], [3]]);
  sheet.addConditionalFormatting({
    ref: 'A1:A3',
    rules: [{ type: 'iconSet', priority: 1, iconSet: '3Stars',
      cfvo: [{ type: 'percent', value: 0 }, { type: 'percent', value: 33 }, { type: 'percent', value: 67 }] }],
  });
  const bytes = await workbook.xlsx.writeBuffer();
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  const restoredSheet = restored.getWorksheet('Проверка')!;
  expect(restoredSheet.getCell('A3').value).toBe(3);
  const model = restoredSheet.model as ExcelJS.WorksheetModel & {
    conditionalFormattings: ExcelJS.ConditionalFormattingOptions[];
  };
  expect(model.conditionalFormattings).toEqual([
    expect.objectContaining({ ref: 'A1:A3', rules: [expect.objectContaining({ type: 'iconSet', iconSet: '3Stars' })] }),
  ]);
});
