// Ajv 8 + TypeScript NodeNext interop: the CJS default export arrives as a
// namespace object whose `.default` is the real class. Direct `import Ajv from
// 'ajv/dist/2020.js'` makes `new Ajv(...)` fail tsc with TS2351. The
// double-cast reaches the class at the type level; esModuleInterop handles the
// runtime side.
import _Ajv from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';
import type { AnySchema, ValidateFunction } from 'ajv';

const Ajv2020 = _Ajv as unknown as typeof _Ajv.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

export type SpecErrorCode =
  | 'schema_violation'
  | 'version_unsupported'
  | 'malformed_stream'
  | 'orphan_reference';

export class SpecError extends Error {
  constructor(
    public readonly code: SpecErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SpecError';
  }
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: SpecError };

export interface Validator {
  register(record: string, version: string, schema: AnySchema): void;
  validate(record: string, version: string, data: unknown): ValidationResult;
}

export function createValidator(): Validator {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const compiled = new Map<string, ValidateFunction>();

  const key = (r: string, v: string) => `${r}@${v}`;

  return {
    register(record, version, schema) {
      compiled.set(key(record, version), ajv.compile(schema));
    },
    validate(record, version, data) {
      const fn = compiled.get(key(record, version));
      if (!fn) {
        return {
          ok: false,
          error: new SpecError(
            'version_unsupported',
            `No schema registered for ${record}@${version}`,
            { record, version },
          ),
        };
      }
      if (fn(data)) return { ok: true };
      return {
        ok: false,
        error: new SpecError(
          'schema_violation',
          `Validation failed for ${record}@${version}`,
          { record, version, errors: fn.errors ?? [] },
        ),
      };
    },
  };
}
