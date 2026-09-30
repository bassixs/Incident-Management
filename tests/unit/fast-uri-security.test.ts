import { expect, it } from 'vitest';
import { resolve } from 'node:path';

const { verify } = require('../../tools/check-fast-uri.cjs');

it('checks every installed fast-uri copy, advisory regressions and Fastify schema compatibility', async () => {
  const result = await verify(resolve(__dirname, '../..'));
  expect(result.copies.map((copy: { version: string }) => copy.version).sort()).toEqual(['3.1.8', '4.1.5']);
  expect(result.fastifySchemaValidationAndSerialization).toBe('passed');
});
