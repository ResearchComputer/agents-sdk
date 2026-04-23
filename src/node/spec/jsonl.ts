import { SpecError } from '../../core/spec/validator.js';

export async function* readJsonlStream(source: NodeJS.ReadableStream): AsyncGenerator<unknown> {
  let buf = '';
  let line = 0;
  for await (const chunk of source) {
    buf += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf-8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      let raw = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      line++;
      if (raw.endsWith('\r')) raw = raw.slice(0, -1);
      if (raw.length === 0) continue;
      yield parseOrThrow(raw, line);
    }
  }
  if (buf.length > 0) {
    line++;
    const last = buf.endsWith('\r') ? buf.slice(0, -1) : buf;
    if (last.length > 0) yield parseOrThrow(last, line);
  }
}

function parseOrThrow(raw: string, line: number): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new SpecError(
      'malformed_stream',
      `Malformed JSON on line ${line}`,
      { line, message: (err as Error).message },
    );
  }
}
