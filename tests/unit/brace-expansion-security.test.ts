import { createRequire } from 'node:module';

import { expect, it } from 'vitest';

const requireFromRoot = createRequire(`${process.cwd()}/package.json`);
const { verify } = requireFromRoot('./tools/check-brace-expansion.cjs') as {
  verify: (root: string) => Array<{ path: string; version: string }>;
};

it('checks every installed brace-expansion copy and bounds hostile pattern expansion', () => {
  expect(verify(process.cwd())).toHaveLength(2);
}, 30000);
