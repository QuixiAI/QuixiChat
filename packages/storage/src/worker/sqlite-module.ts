import initialize from '../../sqlite/dist/sqlite3.mjs';
import wasmUrl from '../../sqlite/dist/sqlite3.wasm?url';
import type { ArchivePool, ArchiveSqlite } from './archives/snapshot.ts';

export interface StorageSqlitePool extends ArchivePool {
  getFileNames(): string[];
}
export interface StorageSqliteModule extends ArchiveSqlite {
  installOpfsSAHPoolVfs(options: {
    name: string;
    directory: string;
    initialCapacity: number;
  }): Promise<StorageSqlitePool>;
}

let initialized: Promise<StorageSqliteModule> | undefined;

/** One pinned SQLite module per Storage Worker, shared by archive and selection. */
export function loadStorageSqlite(): Promise<StorageSqliteModule> {
  if (!initialized) {
    (globalThis as typeof globalThis & { sqlite3ApiConfig: unknown }).sqlite3ApiConfig = {
      disable: { vfs: { opfs: true, 'opfs-wl': true } },
    };
    initialized = initialize({
      locateFile: (file: string) => file.endsWith('.wasm') ? wasmUrl : file,
    }) as Promise<StorageSqliteModule>;
  }
  return initialized;
}
