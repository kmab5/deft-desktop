import type { Snapshot } from './types';

const collections = ['books', 'authors', 'categories', 'types', 'annotations', 'readThroughs', 'sessions', 'folders'] as const;
type Collection = typeof collections[number];
type Entity = Snapshot[Collection][number];
type RowChanges = { upsert: Entity[]; remove: string[]; order?: string[] | null };
type Delta = {
  rows: Partial<Record<Collection, RowChanges>>;
  fields: Pick<Partial<Snapshot>, 'settings' | 'lastScan'>;
};

export type SnapshotReply =
  | { revision: number; full: Snapshot }
  | { revision: number; changes: Delta[]; cacheBytes: number };

export function applyLibraryChanges(previous: Snapshot, reply: SnapshotReply): Snapshot {
  if ('full' in reply) return reply.full;
  let next = previous.cacheBytes === reply.cacheBytes ? previous : { ...previous, cacheBytes: reply.cacheBytes };
  for (const change of reply.changes) {
    next = { ...next, ...change.fields };
    for (const collection of collections) {
      const patch = change.rows[collection];
      if (patch) Object.assign(next, { [collection]: updateRows(next[collection], patch) });
    }
  }
  return next;
}

function updateRows(current: Entity[], patch: RowChanges): Entity[] {
  const rows = new Map(current.map(row => [row.id, row]));
  for (const id of patch.remove) rows.delete(id);
  for (const row of patch.upsert) rows.set(row.id, row);
  return patch.order ? patch.order.flatMap(id => {
    const row = rows.get(id);
    return row ? [row] : [];
  }) : [...rows.values()];
}
