import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import {
  resolvePath,
  isPathAllowed,
  isRealPathAllowed,
  truncateOutput,
  isBinaryContent,
} from './util.js';

describe('resolvePath', () => {
  it('returns absolute paths unchanged', () => {
    expect(resolvePath('/home/user/file.ts', '/some/cwd')).toBe('/home/user/file.ts');
  });

  it('resolves relative paths against cwd', () => {
    expect(resolvePath('file.ts', '/home/user')).toBe('/home/user/file.ts');
  });

  it('resolves paths with ..', () => {
    expect(resolvePath('../other/file.ts', '/home/user/project')).toBe('/home/user/other/file.ts');
  });

  it('normalizes paths with redundant separators', () => {
    expect(resolvePath('/home//user///file.ts', '/cwd')).toBe('/home/user/file.ts');
  });
});

describe('isPathAllowed', () => {
  it('allows paths under cwd', () => {
    expect(isPathAllowed('/home/user/project/src/file.ts', '/home/user/project')).toBe(true);
  });

  it('allows cwd itself', () => {
    expect(isPathAllowed('/home/user/project', '/home/user/project')).toBe(true);
  });

  it('denies paths outside cwd', () => {
    expect(isPathAllowed('/etc/passwd', '/home/user/project')).toBe(false);
  });

  it('prevents prefix attacks (cwd=/home/user, path=/home/username)', () => {
    expect(isPathAllowed('/home/username/file.ts', '/home/user')).toBe(false);
  });

  it('allows paths under allowedRoots', () => {
    expect(isPathAllowed('/opt/data/file.txt', '/home/user', ['/opt/data'])).toBe(true);
  });

  it('prevents prefix attacks on allowedRoots', () => {
    expect(isPathAllowed('/opt/dataextra/file.txt', '/home/user', ['/opt/data'])).toBe(false);
  });

  it('allows allowedRoot itself', () => {
    expect(isPathAllowed('/opt/data', '/home/user', ['/opt/data'])).toBe(true);
  });

  it('normalizes paths before checking', () => {
    expect(isPathAllowed('/home/user/project/../project/file.ts', '/home/user/project')).toBe(true);
  });

  it('uses path-relative containment instead of hard-coded separators', () => {
    const child = path.join('/tmp/project', 'src', 'file.ts');
    expect(isPathAllowed(child, '/tmp/project')).toBe(true);
  });
});

describe('isRealPathAllowed', () => {
  let root: string;
  let outsideDir: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'realpath-root-')));
    outsideDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'realpath-outside-')));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it('denies a symlinked file pointing outside the root', async () => {
    const outsideFile = path.join(outsideDir, 'secret');
    await fs.writeFile(outsideFile, 'secret');
    const link = path.join(root, 'link');
    await fs.symlink(outsideFile, link);
    expect(await isRealPathAllowed(link, root)).toBe(false);
  });

  it('denies a nonexistent path whose ancestor symlink escapes the root', async () => {
    const linkedDir = path.join(root, 'linkdir');
    await fs.symlink(outsideDir, linkedDir);
    const target = path.join(linkedDir, 'new-file.txt');
    expect(await isRealPathAllowed(target, root)).toBe(false);
  });

  it('allows a symlink to a file inside the root', async () => {
    const real = path.join(root, 'real');
    await fs.writeFile(real, 'ok');
    const link = path.join(root, 'link');
    await fs.symlink(real, link);
    expect(await isRealPathAllowed(link, root)).toBe(true);
  });

  it('allows a nonexistent path when ancestors are within root', async () => {
    const target = path.join(root, 'subdir', 'not-yet.txt');
    expect(await isRealPathAllowed(target, root)).toBe(true);
  });

  it('denies a lexically outside path', async () => {
    expect(await isRealPathAllowed('/etc/passwd', root)).toBe(false);
  });
});

describe('truncateOutput', () => {
  it('returns short output unchanged', () => {
    expect(truncateOutput('hello', 100)).toBe('hello');
  });

  it('truncates output over maxBytes', () => {
    const output = 'a'.repeat(200);
    const result = truncateOutput(output, 100);
    expect(result.length).toBeLessThanOrEqual(150); // some room for truncation message
    expect(result).toContain('[truncated]');
  });

  it('handles empty string', () => {
    expect(truncateOutput('', 100)).toBe('');
  });
});

describe('isBinaryContent', () => {
  it('detects binary content with null bytes', () => {
    const buf = Buffer.from([0x48, 0x65, 0x6c, 0x00, 0x6f]);
    expect(isBinaryContent(buf)).toBe(true);
  });

  it('returns false for text content', () => {
    const buf = Buffer.from('Hello, world!\n');
    expect(isBinaryContent(buf)).toBe(false);
  });

  it('handles empty buffer', () => {
    expect(isBinaryContent(Buffer.alloc(0))).toBe(false);
  });

  it('only checks first 8KB', () => {
    const buf = Buffer.alloc(16 * 1024, 0x41); // all 'A'
    buf[10000] = 0x00; // null byte after 8KB
    expect(isBinaryContent(buf)).toBe(false);
  });
});
