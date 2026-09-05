import { expect, it } from 'vitest';
import { AppError, ValidationError, reportActionError } from '../../src/utils/errors';

it('preserves the original technical failure when user feedback also fails', async () => {
  const original = new AppError('Missing chat configuration', 'CONFIG_MISSING');
  await expect(reportActionError(original, async () => { throw new Error('MAX unavailable'); })).rejects.toBe(original);
});

it('reports failed feedback for an otherwise expected validation refusal', async () => {
  const feedback = new Error('MAX unavailable');
  await expect(reportActionError(new ValidationError('Invalid text'), async () => { throw feedback; })).rejects.toBe(feedback);
});
