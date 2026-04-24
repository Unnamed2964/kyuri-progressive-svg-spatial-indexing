import { describe, expect, it, vi } from 'vitest';

import { IndexedSvgController, type SpatialIndexAdapter, type SpatialIndexItem, type WorldAabb } from '../src/index.js';

interface TestHandle<TMeta> {
  items: Map<string, SpatialIndexItem<TMeta>>;
}

class ArrayAdapter<TMeta> implements SpatialIndexAdapter<SpatialIndexItem<TMeta>, TestHandle<TMeta>> {
  create(): TestHandle<TMeta> {
    return { items: new Map() };
  }

  batchUpdate(handle: TestHandle<TMeta>, batch: { upserts: SpatialIndexItem<TMeta>[]; removes: string[] }): TestHandle<TMeta> {
    const next = { items: new Map(handle.items) };
    for (const key of batch.removes) {
      next.items.delete(key);
    }
    for (const item of batch.upserts) {
      next.items.set(item.key, item);
    }
    return next;
  }

  queryRect(handle: TestHandle<TMeta>, rect: WorldAabb): SpatialIndexItem<TMeta>[] {
    return [...handle.items.values()].filter((item) => intersects(item.bbox, rect));
  }
}

describe('IndexedSvgController', () => {
  it('indexes existing matching elements and queries by world rect', () => {
    const svg = createSvgRoot();
    const rect = createRect('node-a');
    stubGeometry(rect, { x: 0, y: 0, width: 10, height: 20 }, { a: 1, b: 0, c: 0, d: 1, e: 100, f: 200 });
    svg.append(rect);

    const controller = createController();
    controller.attach(svg);
    controller.flush();

    const results = controller.queryRect({ minX: 95, minY: 195, maxX: 115, maxY: 225 });
    expect(results).toHaveLength(1);
    expect(results[0]?.key).toBe('node-a');
    expect(results[0]?.bbox).toEqual({ minX: 100, minY: 200, maxX: 110, maxY: 220 });
  });

  it('removes elements without waiting for a measurement frame when subtree nodes are removed', async () => {
    const svg = createSvgRoot();
    const rect = createRect('node-a');
    stubGeometry(rect, { x: 0, y: 0, width: 10, height: 10 }, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    svg.append(rect);

    const controller = createController();
    controller.attach(svg);
    controller.flush();
    rect.remove();
    await Promise.resolve();

    expect(controller.queryRect({ minX: -1, minY: -1, maxX: 20, maxY: 20 })).toHaveLength(0);
  });

  it('re-measures when transform changes on the element', async () => {
    const svg = createSvgRoot();
    const rect = createRect('node-a');
    let offsetX = 0;
    stubDynamicGeometry(rect, () => ({ x: 0, y: 0, width: 10, height: 10 }), () => ({ a: 1, b: 0, c: 0, d: 1, e: offsetX, f: 0 }));
    svg.append(rect);

    const requestFrame = createFrameQueue();
    const controller = createController({ requestFrame: requestFrame.request, cancelFrame: requestFrame.cancel });
    controller.attach(svg);
    requestFrame.flush();

    offsetX = 50;
    rect.setAttribute('transform', 'translate(50,0)');
    await Promise.resolve();
    requestFrame.flush();

    const results = controller.queryRect({ minX: 45, minY: -5, maxX: 65, maxY: 15 });
    expect(results).toHaveLength(1);
    expect(results[0]?.bbox.minX).toBe(50);
  });

  it('propagates ancestor transform changes to tracked descendants', async () => {
    const svg = createSvgRoot();
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const rect = createRect('node-a');
    let groupOffset = 0;
    stubDynamicGeometry(rect, () => ({ x: 0, y: 0, width: 10, height: 10 }), () => ({ a: 1, b: 0, c: 0, d: 1, e: groupOffset, f: 0 }));
    group.append(rect);
    svg.append(group);

    const requestFrame = createFrameQueue();
    const controller = createController({ requestFrame: requestFrame.request, cancelFrame: requestFrame.cancel });
    controller.attach(svg);
    requestFrame.flush();

    groupOffset = 75;
    group.setAttribute('transform', 'translate(75,0)');
    await Promise.resolve();
    requestFrame.flush();

    const results = controller.queryRect({ minX: 70, minY: -5, maxX: 90, maxY: 15 });
    expect(results).toHaveLength(1);
    expect(results[0]?.bbox.minX).toBe(75);
  });

  it('deduplicates repeated invalidations within a frame', async () => {
    const svg = createSvgRoot();
    const rect = createRect('node-a');
    const getBBox = vi.fn(() => ({ x: 0, y: 0, width: 10, height: 10 }));
    const getCTM = vi.fn(() => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }));
    Object.defineProperty(rect, 'getBBox', { value: getBBox });
    Object.defineProperty(rect, 'getCTM', { value: getCTM });
    svg.append(rect);

    const requestFrame = createFrameQueue();
    const controller = createController({ requestFrame: requestFrame.request, cancelFrame: requestFrame.cancel });
    controller.attach(svg);
    requestFrame.flush();
    getBBox.mockClear();

    rect.setAttribute('x', '10');
    rect.setAttribute('y', '20');
    rect.setAttribute('width', '30');
    await Promise.resolve();
    requestFrame.flush();

    expect(getBBox).toHaveBeenCalledTimes(1);
  });
});

function createController(overrides?: Partial<ConstructorParameters<typeof IndexedSvgController<unknown, TestHandle<unknown>>>[0]>) {
  return new IndexedSvgController({
    adapter: new ArrayAdapter(),
    ...overrides
  });
}

function createSvgRoot(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  document.body.append(svg);
  return svg;
}

function createRect(id: string): SVGGraphicsElement {
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('id', id);
  return rect as unknown as SVGGraphicsElement;
}

function stubGeometry(element: SVGGraphicsElement, bbox: DOMRectInit, matrix: DOMMatrixInit): void {
  Object.defineProperty(element, 'getBBox', {
    value: () => ({ x: bbox.x ?? 0, y: bbox.y ?? 0, width: bbox.width ?? 0, height: bbox.height ?? 0 })
  });
  Object.defineProperty(element, 'getCTM', {
    value: () => ({
      a: matrix.a ?? 1,
      b: matrix.b ?? 0,
      c: matrix.c ?? 0,
      d: matrix.d ?? 1,
      e: matrix.e ?? 0,
      f: matrix.f ?? 0
    })
  });
}

function stubDynamicGeometry(
  element: SVGGraphicsElement,
  bboxFactory: () => DOMRectInit,
  matrixFactory: () => DOMMatrixInit
): void {
  Object.defineProperty(element, 'getBBox', {
    value: () => {
      const bbox = bboxFactory();
      return { x: bbox.x ?? 0, y: bbox.y ?? 0, width: bbox.width ?? 0, height: bbox.height ?? 0 };
    }
  });
  Object.defineProperty(element, 'getCTM', {
    value: () => {
      const matrix = matrixFactory();
      return {
        a: matrix.a ?? 1,
        b: matrix.b ?? 0,
        c: matrix.c ?? 0,
        d: matrix.d ?? 1,
        e: matrix.e ?? 0,
        f: matrix.f ?? 0
      };
    }
  });
}

function intersects(left: WorldAabb, right: WorldAabb): boolean {
  return !(left.maxX < right.minX || left.minX > right.maxX || left.maxY < right.minY || left.minY > right.maxY);
}

function createFrameQueue() {
  let nextHandle = 1;
  const queue = new Map<number, FrameRequestCallback>();

  return {
    request: (callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      queue.set(handle, callback);
      return handle;
    },
    cancel: (handle: number) => {
      queue.delete(handle);
    },
    flush: () => {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const callback of callbacks) {
        callback(0);
      }
    }
  };
}