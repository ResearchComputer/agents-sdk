import { describe, it, expect } from 'vitest';
import { jsonSchemaToTypeBox } from './schema-convert.js';
import { Value } from '@sinclair/typebox/value';

describe('jsonSchemaToTypeBox', () => {
  it('converts a simple object schema', () => {
    const result = jsonSchemaToTypeBox({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name' },
        age: { type: 'number' },
      },
      required: ['name'],
    });

    expect(result.isExact).toBe(true);
    expect(result.warnings).toHaveLength(0);

    // Validate data against the converted schema
    expect(Value.Check(result.schema, { name: 'Alice', age: 30 })).toBe(true);
    expect(Value.Check(result.schema, { name: 'Bob' })).toBe(true);
    expect(Value.Check(result.schema, { age: 30 })).toBe(false); // name is required
  });

  it('converts boolean and array types', () => {
    const result = jsonSchemaToTypeBox({
      type: 'object',
      properties: {
        active: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    });

    expect(result.isExact).toBe(true);
    expect(Value.Check(result.schema, { active: true, tags: ['a', 'b'] })).toBe(true);
    expect(Value.Check(result.schema, { tags: [123] })).toBe(false);
  });

  it('converts string enums', () => {
    const result = jsonSchemaToTypeBox({
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'closed'] },
      },
      required: ['status'],
    });

    expect(result.isExact).toBe(true);
    expect(Value.Check(result.schema, { status: 'open' })).toBe(true);
    expect(Value.Check(result.schema, { status: 'invalid' })).toBe(false);
  });

  it('falls back to Any for unsupported keywords', () => {
    const result = jsonSchemaToTypeBox({
      type: 'object',
      properties: {
        data: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
    });

    expect(result.isExact).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('oneOf');
  });

  it('handles empty schema', () => {
    const result = jsonSchemaToTypeBox({});
    expect(result.isExact).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('handles null type', () => {
    const result = jsonSchemaToTypeBox({ type: 'null' });
    expect(result.isExact).toBe(true);
    expect(Value.Check(result.schema, null)).toBe(true);
  });

  it('handles implicit object (no type but has properties)', () => {
    const result = jsonSchemaToTypeBox({
      properties: {
        foo: { type: 'string' },
      },
      required: ['foo'],
    });

    expect(result.isExact).toBe(true);
    expect(Value.Check(result.schema, { foo: 'bar' })).toBe(true);
    expect(Value.Check(result.schema, {})).toBe(false);
  });

  it('preserves description in schema options', () => {
    const result = jsonSchemaToTypeBox({
      type: 'string',
      description: 'A greeting message',
    });

    expect(result.schema.description).toBe('A greeting message');
  });

  it('handles integer type', () => {
    const result = jsonSchemaToTypeBox({ type: 'integer' });
    expect(result.isExact).toBe(true);
    expect(Value.Check(result.schema, 42)).toBe(true);
  });

  it('falls back to Any for $ref', () => {
    const result = jsonSchemaToTypeBox({ $ref: '#/definitions/Foo' });
    expect(result.isExact).toBe(false);
    expect(result.warnings[0]).toContain('$ref');
  });

  it('warns and falls back to Any for null schema', () => {
    const result = jsonSchemaToTypeBox(null as unknown as Record<string, any>);
    expect(result.isExact).toBe(false);
    expect(result.warnings[0]).toMatch(/Missing or invalid schema/);
  });

  it('warns and falls back to Any for non-object schema', () => {
    const result = jsonSchemaToTypeBox('oops' as unknown as Record<string, any>);
    expect(result.isExact).toBe(false);
    expect(result.warnings[0]).toMatch(/Missing or invalid schema/);
  });

  it('treats an array without items as Array<Any>', () => {
    const result = jsonSchemaToTypeBox({ type: 'array' });
    expect(result.isExact).toBe(true);
    expect(Value.Check(result.schema, [1, 'a', { x: true }])).toBe(true);
  });

  it('warns on unknown type strings', () => {
    const result = jsonSchemaToTypeBox({ type: 'magic' });
    expect(result.isExact).toBe(false);
    expect(result.warnings[0]).toMatch(/Unknown type: magic/);
  });
});
