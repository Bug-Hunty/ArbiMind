import type * as FileSystem from 'fs';
import path from 'path';

export interface JournalFiles {
  roots: Set<string>;
  files: Map<string, Buffer>;
}

/**
 * Deterministic storage for the large readiness fixture only. EconomicsJournal
 * still validates, reads, writes and renames every observation itself. Other
 * paths, including the durability tests, use the real filesystem.
 */
export function journalFilesystem(actual: typeof FileSystem, state: JournalFiles): typeof FileSystem {
  const virtual = (file: unknown): file is string => typeof file === 'string' &&
    [...state.roots].some(root => file === root || file.startsWith(root + path.sep));
  const missing = () => Object.assign(new Error('journal fixture file does not exist'), { code: 'ENOENT' });

  return {
    ...actual,
    existsSync(file) {
      return virtual(file) ? state.files.has(file) || state.roots.has(file) : actual.existsSync(file);
    },
    mkdirSync(...args: Parameters<typeof actual.mkdirSync>) {
      if (virtual(args[0])) return undefined;
      return actual.mkdirSync(...args);
    },
    readFileSync(...args: Parameters<typeof actual.readFileSync>) {
      if (!virtual(args[0])) return actual.readFileSync(...args);
      const bytes = state.files.get(args[0]);
      if (!bytes) throw missing();
      const options = args[1];
      const encoding = typeof options === 'string' ? options : options?.encoding;
      return encoding ? bytes.toString(encoding) : Buffer.from(bytes);
    },
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      if (!virtual(args[0])) return actual.writeFileSync(...args);
      const data = args[1];
      state.files.set(args[0], typeof data === 'string' ? Buffer.from(data) : Buffer.from(data as Uint8Array));
    },
    renameSync(oldPath, newPath) {
      if (!virtual(oldPath) || !virtual(newPath)) return actual.renameSync(oldPath, newPath);
      const bytes = state.files.get(oldPath);
      if (!bytes) throw missing();
      state.files.set(newPath, bytes);
      state.files.delete(oldPath);
    },
  } as typeof FileSystem;
}
