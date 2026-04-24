import { describe, expect, it } from 'vitest';

import { createRbushSpatialIndexAdapter, type SpatialIndexItem } from '../src/index.js';

describe('RbushSpatialIndexAdapter', () => {
  it('creates an empty handle and returns no matches', () => {
    const adapter = createAdapter();
    const handle = adapter.create();

    const results = adapter.queryRect(handle, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(results).toEqual([]);
  });

  it('upserts and removes by stable key', () => {
    const adapter = createAdapter();
    let handle = adapter.create();

    handle = adapter.batchUpdate(handle, {
      upserts: [
        createItem('a', 0, 0, 10, 10),
        createItem('b', 20, 20, 30, 30)
      ],
      removes: []
    });

    expect(adapter.queryRect(handle, { minX: -1, minY: -1, maxX: 11, maxY: 11 }).map((item) => item.key)).toEqual(['a']);

    handle = adapter.batchUpdate(handle, {
      upserts: [createItem('a', 100, 100, 110, 110)],
      removes: ['b']
    });

    expect(adapter.queryRect(handle, { minX: -1, minY: -1, maxX: 40, maxY: 40 })).toEqual([]);
    expect(adapter.queryRect(handle, { minX: 95, minY: 95, maxX: 115, maxY: 115 }).map((item) => item.key)).toEqual(['a']);
  });

  it('returns the same handle with updated contents', () => {
    const adapter = createAdapter();
    const handle = adapter.create();
    const nextHandle = adapter.batchUpdate(handle, {
      upserts: [createItem('a', 0, 0, 10, 10)],
      removes: []
    });

    expect(nextHandle).toBe(handle);
    expect(adapter.queryRect(handle, { minX: -1, minY: -1, maxX: 20, maxY: 20 })).toHaveLength(1);
    expect(adapter.queryRect(nextHandle, { minX: -1, minY: -1, maxX: 20, maxY: 20 })).toHaveLength(1);
  });
});

function createAdapter() {
  return createRbushSpatialIndexAdapter<SpatialIndexItem>({
    getKey: (item) => item.key,
    getBounds: (item) => item.bbox
  });
}

function createItem(key: string, minX: number, minY: number, maxX: number, maxY: number): SpatialIndexItem {
  return {
    key,
    element: document.createElementNS('http://www.w3.org/2000/svg', 'rect') as unknown as SVGGraphicsElement,
    bbox: { minX, minY, maxX, maxY },
    metadata: undefined
  };
}