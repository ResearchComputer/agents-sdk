import { describe, it, expect } from 'vitest';
import { createValidator, SpecError } from './validator.js';

const toySchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.com/toy.v1.schema.json',
  type: 'object',
  required: ['schema_version', 'name'],
  properties: {
    schema_version: { const: '1' },
    name: { type: 'string' },
    ext: { type: 'object', additionalProperties: true },
  },
  additionalProperties: false,
};

describe('validator — success path', () => {
  it('returns ok for a valid record', () => {
    const v = createValidator();
    v.register('toy', '1', toySchema);
    const result = v.validate('toy', '1', { schema_version: '1', name: 'hi' });
    expect(result.ok).toBe(true);
  });

  it('ignores unknown top-level fields if schema allows, rejects if closed', () => {
    const v = createValidator();
    v.register('toy', '1', toySchema);
    const result = v.validate('toy', '1', { schema_version: '1', name: 'hi', unknown: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('schema_violation');
    }
  });

  it('accepts ext namespace contents freely', () => {
    const v = createValidator();
    v.register('toy', '1', toySchema);
    const result = v.validate('toy', '1', {
      schema_version: '1',
      name: 'hi',
      ext: { rl: { reward: 1 }, eval: { score: 4 } },
    });
    expect(result.ok).toBe(true);
  });

  it('returns version_unsupported when no schema is registered for the key', () => {
    const v = createValidator();
    v.register('toy', '1', toySchema);
    const result = v.validate('toy', '99', { any: 'thing' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SpecError);
      expect(result.error.code).toBe('version_unsupported');
      expect(result.error.details).toMatchObject({ record: 'toy', version: '99' });
    }
  });

  it('returns version_unsupported for an unknown record name', () => {
    const v = createValidator();
    const result = v.validate('missing', '1', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('version_unsupported');
    }
  });
});
