import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import { OpenAiCompatibleClient, toStrictJsonSchema } from '../../src/ai/openai-client';
import { AppError } from '../../src/utils/errors';

const client = new OpenAiCompatibleClient({
  baseUrl: 'https://api.example.test/v1/',
  apiKey: 'test-key',
  model: 'test-model',
  timeoutMs: 5000,
});

type FetchArgs = { url: string; init: RequestInit };

function stubFetch(body: unknown, status = 200): { calls: FetchArgs[] } {
  const calls: FetchArgs[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  });
  return { calls };
}

function completion(content: string, extra: Record<string, unknown> = {}) {
  return { choices: [{ finish_reason: 'stop', message: { content }, ...extra }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAI-compatible transport', () => {
  it('posts to /chat/completions with bearer auth', async () => {
    const { calls } = stubFetch(completion('Париж'));

    const text = await client.complete([{ role: 'user', content: 'Столица Франции?' }]);

    expect(text).toBe('Париж');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/chat/completions');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(calls[0]!.init.body as string).model).toBe('test-model');
  });

  it('sends a strict json_schema when structured output is requested', async () => {
    const { calls } = stubFetch(completion('{"ok":true}'));
    const schema = z.object({ ok: z.boolean() });

    const parsed = await client.completeJson([{ role: 'user', content: 'дай json' }], schema, 'probe');

    expect(parsed).toEqual({ ok: true });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
  });

  /** A gateway may report failure in the body while still answering HTTP 200. */
  it('treats an error object in a 200 body as a failure', async () => {
    stubFetch({ error: { message: 'модель не найдена', code: 400 } });
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(AppError);
  });

  it('fails on a non-2xx response', async () => {
    stubFetch({}, 502);
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toThrow('HTTP 502');
  });

  it('fails on a refusal', async () => {
    stubFetch({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'нет' } }] });
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toThrow('отказался');
  });

  /** Reasoning models can spend the budget before answering. */
  it('fails when the answer was truncated by the token limit', async () => {
    stubFetch({ choices: [{ finish_reason: 'length', message: { content: '{"partial":' } }] });
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toThrow('обрезан');
  });

  it('fails on an empty answer', async () => {
    stubFetch(completion('   '));
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toThrow('пустой');
  });

  it('rejects JSON that does not match the schema', async () => {
    stubFetch(completion('{"ok":"да"}'));
    const schema = z.object({ ok: z.boolean() });
    await expect(
      client.completeJson([{ role: 'user', content: 'x' }], schema, 'probe'),
    ).rejects.toThrow('структуре');
  });

  it('rejects a non-JSON body where JSON was demanded', async () => {
    stubFetch(completion('конечно, вот ответ'));
    const schema = z.object({ ok: z.boolean() });
    await expect(
      client.completeJson([{ role: 'user', content: 'x' }], schema, 'probe'),
    ).rejects.toThrow('не-JSON');
  });

  it('turns a network failure into a typed error rather than leaking it', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(AppError);
  });
});

describe('schema conversion', () => {
  it('produces the strict shape OpenAI requires and drops $schema', () => {
    const json = toStrictJsonSchema(
      z.object({ items: z.array(z.object({ code: z.string(), score: z.number() })) }),
    );
    expect(json.$schema).toBeUndefined();
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(['items']);
  });
});
