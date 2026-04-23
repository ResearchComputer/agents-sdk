import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { readJsonlStream } from './jsonl.js';

function stream(s: string): NodeJS.ReadableStream {
  return Readable.from(Buffer.from(s, 'utf-8'));
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('jsonl', () => {
  it('yields parsed objects one per line', async () => {
    const src = stream('{"a":1}\n{"a":2}\n{"a":3}\n');
    const out = await collect(readJsonlStream(src));
    expect(out).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('handles no trailing newline', async () => {
    const src = stream('{"a":1}\n{"a":2}');
    const out = await collect(readJsonlStream(src));
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('throws malformed_stream with line number on bad json', async () => {
    const src = stream('{"a":1}\n{not json}\n{"a":3}\n');
    await expect(collect(readJsonlStream(src))).rejects.toMatchObject({
      code: 'malformed_stream',
      details: { line: 2 },
    });
  });

  it('rejects a file containing only blank lines as empty output', async () => {
    const src = stream('\n\n\n');
    const out = await collect(readJsonlStream(src));
    expect(out).toEqual([]);
  });

  it('tolerates CRLF line endings by stripping trailing \\r', async () => {
    const src = stream('{"a":1}\r\n{"a":2}\r\n');
    const out = await collect(readJsonlStream(src));
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
