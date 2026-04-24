import type { BatchUpdate, WorldAabb } from './types.js';

export interface SpatialIndexAdapter<TItem, THandle> {
  create(): THandle;
  batchUpdate(handle: THandle, batch: BatchUpdate<TItem>): THandle;
  queryRect(handle: THandle, rect: WorldAabb): TItem[];
  dispose?(handle: THandle): void;
}

export interface SpatialIndexAabbLike {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}