import RBush from 'rbush';

import type { SpatialIndexAdapter, SpatialIndexAabbLike } from '../adapter.js';
import type { BatchUpdate, WorldAabb } from '../types.js';

interface RbushEntry<TItem> extends SpatialIndexAabbLike {
  key: string;
  item: TItem;
}

export type RbushIndexHandle<TItem> = RBush<RbushEntry<TItem>>;

export interface RbushAdapterOptions<TItem> {
  maxEntries?: number;
  getKey: (item: TItem) => string;
  getBounds?: (item: TItem) => SpatialIndexAabbLike;
}

export class RbushSpatialIndexAdapter<TItem>
  implements SpatialIndexAdapter<TItem, RbushIndexHandle<TItem>>
{
  private readonly maxEntries: number | undefined;
  private readonly getKey: (item: TItem) => string;
  private readonly getBounds: (item: TItem) => SpatialIndexAabbLike;

  constructor(options: RbushAdapterOptions<TItem>) {
    this.maxEntries = options.maxEntries;
    this.getKey = options.getKey;
    this.getBounds = options.getBounds ?? defaultGetBounds;
  }

  create(): RbushIndexHandle<TItem> {
    return new RBush<RbushEntry<TItem>>(this.maxEntries);
  }

  batchUpdate(handle: RbushIndexHandle<TItem>, batch: BatchUpdate<TItem>): RbushIndexHandle<TItem> {
    // RBush removes by object identity, so we rebuild a key -> entry map from the current tree before editing it in place.
    const entriesByKey = new Map<string, RbushEntry<TItem>>();
    for (const entry of handle.all()) {
      entriesByKey.set(entry.key, entry);
    }

    for (const key of batch.removes) {
      const existingEntry = entriesByKey.get(key);
      if (!existingEntry) {
        continue;
      }

      handle.remove(existingEntry);
      entriesByKey.delete(key);
    }

    // Upsert means "replace by key": remove the old entry first, then insert the new one.
    for (const item of batch.upserts) {
      const nextEntry = this.toEntry(item);
      const existingEntry = entriesByKey.get(nextEntry.key);
      if (existingEntry) {
        handle.remove(existingEntry);
      }

      handle.insert(nextEntry);
      entriesByKey.set(nextEntry.key, nextEntry);
    }

    return handle;
  }

  queryRect(handle: RbushIndexHandle<TItem>, rect: WorldAabb): TItem[] {
    return handle.search(rect).map((entry) => entry.item);
  }

  dispose(): void {
    // No-op. RBush handle is GC-managed.
  }

  private toEntry(item: TItem): RbushEntry<TItem> {
    const bounds = this.getBounds(item);
    return {
      key: this.getKey(item),
      item,
      minX: bounds.minX,
      minY: bounds.minY,
      maxX: bounds.maxX,
      maxY: bounds.maxY
    };
  }
}

export function createRbushSpatialIndexAdapter<TItem>(
  options: RbushAdapterOptions<TItem>
): RbushSpatialIndexAdapter<TItem> {
  return new RbushSpatialIndexAdapter(options);
}

function defaultGetBounds<TItem>(item: TItem): SpatialIndexAabbLike {
  // This fallback keeps the adapter ergonomic for already-flattened items, while still allowing nested bbox via getBounds.
  if (
    typeof item === 'object' &&
    item !== null &&
    'minX' in item &&
    'minY' in item &&
    'maxX' in item &&
    'maxY' in item
  ) {
    const bounds = item as SpatialIndexAabbLike;
    return {
      minX: bounds.minX,
      minY: bounds.minY,
      maxX: bounds.maxX,
      maxY: bounds.maxY
    };
  }

  throw new Error('RbushSpatialIndexAdapter requires getBounds when items do not expose minX/minY/maxX/maxY directly.');
}