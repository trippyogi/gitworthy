import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { WatchRecordSchema, type WatchRecord } from '../contracts/watch.js';
import { storeRoot, withStoreLock, writeJsonAtomic } from './store-fs.js';

function watchDir(): string {
  return path.join(storeRoot(), 'watch');
}

function watchFile(id: string): string {
  return path.join(watchDir(), `${id}.json`);
}

export async function putWatchRecord(record: WatchRecord): Promise<WatchRecord> {
  const parsed = WatchRecordSchema.parse(record);
  await withStoreLock(`watch:${parsed.watch_id}`, async () => {
    await writeJsonAtomic(watchFile(parsed.watch_id), parsed);
  });
  return parsed;
}

export async function getWatchRecord(watchId: string): Promise<WatchRecord | null> {
  try {
    const raw = await readFile(watchFile(watchId), 'utf8');
    return WatchRecordSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function listWatchRecords(): Promise<WatchRecord[]> {
  try {
    const names = await readdir(watchDir());
    const rows: WatchRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const row = await getWatchRecord(name.replace(/\.json$/, ''));
      if (row) rows.push(row);
    }
    return rows.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  } catch {
    return [];
  }
}

export async function removeWatchRecord(watchId: string): Promise<boolean> {
  const existing = await getWatchRecord(watchId);
  if (!existing) return false;
  await withStoreLock(`watch:${watchId}`, async () => {
    await rm(watchFile(watchId), { force: true });
  });
  return true;
}
