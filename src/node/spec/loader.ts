import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function findSpecDir(startFrom?: string): Promise<string> {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));

  // Fast-path: the published tarball places schemas at dist/spec/schemas
  // (populated by scripts/copy-spec.ts during `bun run build`). When running
  // from node_modules this is the only location that exists — the
  // `docs/spec/` development tree is not shipped alongside source files.
  // Look one level up from dist/node/spec/ → dist/spec/.
  if (!startFrom) {
    const inPkgCandidate = path.join(selfDir, '..', 'spec');
    try {
      await fs.stat(path.join(inPkgCandidate, 'schemas'));
      return inPkgCandidate;
    } catch {
      // Fall through to dev-mode walker.
    }
  }

  // Dev-mode: walk up from the module location looking for docs/spec/schemas/.
  let dir = startFrom ?? selfDir;
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidate = path.join(dir, 'docs', 'spec');
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        await fs.stat(path.join(candidate, 'schemas'));
        return candidate;
      }
    } catch {
      // continue walking up
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    'Could not locate docs/spec/ directory by walking up from ' +
      (startFrom ?? 'module location'),
  );
}

export async function loadSchema(record: string, version: string, specDir?: string): Promise<object> {
  const dir = specDir ?? await findSpecDir();
  const file = path.join(dir, 'schemas', `${record}.v${version}.schema.json`);
  let content: string;
  try {
    content = await fs.readFile(file, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`Schema file not found: ${path.basename(file)} (looked in ${path.dirname(file)})`);
    }
    throw err;
  }
  return JSON.parse(content);
}
