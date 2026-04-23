import * as fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve a file path against a working directory.
 * Absolute paths are returned normalized; relative paths are resolved against cwd.
 */
export function resolvePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) {
    return path.resolve(filePath);
  }
  return path.resolve(cwd, filePath);
}

/**
 * Check if an absolute path is under cwd or any of the allowed roots.
 * Uses exact prefix matching with path separator to prevent prefix attacks.
 */
export function isPathAllowed(absPath: string, cwd: string, allowedRoots: string[] = []): boolean {
  const normalized = path.resolve(absPath);
  const normalizedCwd = path.resolve(cwd);

  const roots = [normalizedCwd, ...allowedRoots.map(r => path.resolve(r))];
  return roots.some((root) => {
    if (normalized === root) return true;
    const relative = path.relative(root, normalized);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

async function realpathBestEffort(p: string): Promise<string> {
  let current = path.resolve(p);
  const tail: string[] = [];
  while (true) {
    try {
      const real = await fs.realpath(current);
      return tail.length > 0 ? path.join(real, ...tail) : real;
    } catch (err: any) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Like isPathAllowed, but follows symlinks via realpath so a symlink inside
 * the allowed root cannot escape to an external target. For paths that don't
 * exist yet, resolves the deepest existing ancestor and re-checks containment
 * against the resolved path.
 */
export async function isRealPathAllowed(
  absPath: string,
  cwd: string,
  allowedRoots: string[] = [],
): Promise<boolean> {
  if (!isPathAllowed(path.resolve(absPath), cwd, allowedRoots)) return false;
  const [realPath, realCwd, ...realRoots] = await Promise.all([
    realpathBestEffort(absPath),
    realpathBestEffort(cwd),
    ...allowedRoots.map(realpathBestEffort),
  ]);
  return isPathAllowed(realPath, realCwd, realRoots);
}

/**
 * Truncate output to maxBytes, appending a truncation message if needed.
 */
export function truncateOutput(output: string, maxBytes: number): string {
  if (Buffer.byteLength(output, 'utf-8') <= maxBytes) {
    return output;
  }
  const truncated = Buffer.from(output, 'utf-8').subarray(0, maxBytes).toString('utf-8');
  return truncated + '\n[truncated]';
}

/**
 * Detect binary content by checking for null bytes in the first 8KB.
 */
export function isBinaryContent(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0x00) {
      return true;
    }
  }
  return false;
}
