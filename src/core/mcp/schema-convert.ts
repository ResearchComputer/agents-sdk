import { Type, type TSchema } from '@sinclair/typebox';
import type { SchemaConversionResult } from '../types.js';

export function jsonSchemaToTypeBox(jsonSchema: Record<string, any>): SchemaConversionResult {
  const warnings: string[] = [];
  const schema = convert(jsonSchema, warnings);
  return {
    schema,
    isExact: warnings.length === 0,
    warnings,
  };
}

function convert(schema: Record<string, any>, warnings: string[]): TSchema {
  if (!schema || typeof schema !== 'object') {
    warnings.push('Missing or invalid schema');
    return Type.Any();
  }

  // Check for unsupported combinators
  for (const key of ['oneOf', 'allOf', 'anyOf', '$ref']) {
    if (key in schema) {
      warnings.push(`Unsupported keyword: ${key}`);
      return withDescription(Type.Any(), schema.description);
    }
  }

  const type = schema.type;

  // Implicit object: no type but has properties
  if (!type && schema.properties) {
    return convertObject(schema, warnings);
  }

  if (!type) {
    warnings.push('Unknown or missing type');
    return withDescription(Type.Any(), schema.description);
  }

  switch (type) {
    case 'string':
      if (schema.enum && Array.isArray(schema.enum)) {
        return withDescription(
          Type.Union(schema.enum.map((v: string) => Type.Literal(v))),
          schema.description,
        );
      }
      return withDescription(Type.String(), schema.description);

    case 'number':
    case 'integer':
      return withDescription(Type.Number(), schema.description);

    case 'boolean':
      return withDescription(Type.Boolean(), schema.description);

    case 'null':
      return withDescription(Type.Null(), schema.description);

    case 'array':
      if (schema.items) {
        return withDescription(Type.Array(convert(schema.items, warnings)), schema.description);
      }
      return withDescription(Type.Array(Type.Any()), schema.description);

    case 'object':
      return convertObject(schema, warnings);

    default:
      warnings.push(`Unknown type: ${type}`);
      return withDescription(Type.Any(), schema.description);
  }
}

function convertObject(schema: Record<string, any>, warnings: string[]): TSchema {
  const properties = schema.properties ?? {};
  const required = new Set<string>(schema.required ?? []);

  const props: Record<string, TSchema> = {};
  for (const [key, value] of Object.entries(properties)) {
    const converted = convert(value as Record<string, any>, warnings);
    props[key] = required.has(key) ? converted : Type.Optional(converted);
  }

  return withDescription(Type.Object(props), schema.description);
}

function withDescription<T extends TSchema>(schema: T, description?: string): T {
  if (description) {
    return { ...schema, description } as T;
  }
  return schema;
}
