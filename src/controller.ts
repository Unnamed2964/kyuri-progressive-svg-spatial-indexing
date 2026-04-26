import type { SpatialIndexAdapter } from './adapter.js';
import { areAabbsEqual, toAabbInCoordinateSpace } from './geometry.js';
import type {
  FlushStats,
  IndexedSvgEvents,
  IndexedSvgSnapshot,
  SpatialIndexItem,
  WorldAabb
} from './types.js';

type EventName = keyof IndexedSvgEvents;
type Listener<T> = (payload: T) => void;

type DirtyReason = 'measure' | 'structure';

interface TrackedRecord<TMetadata> {
  key: string;
  element: SVGGraphicsElement;
  metadata: TMetadata;
  bbox?: WorldAabb;
}

type GraphicsElementLike = SVGElement & Pick<SVGGraphicsElement, 'getBBox' | 'getCTM'>;
type CoordinateReferenceElement = SVGElement & {
  getCTM(): DOMMatrix | SVGMatrix | null;
};

/**
 * Controller configuration.
 *
 * Contract: attach() must receive the dedicated index layer, and each tracked graphic must be a
 * direct child of that layer.
 */
export interface IndexedSvgControllerOptions<TMetadata, THandle> {
  adapter: SpatialIndexAdapter<SpatialIndexItem<TMetadata>, THandle>;
  keyExtractor?: (element: SVGGraphicsElement) => string | null;
  metadataExtractor?: (element: SVGGraphicsElement) => TMetadata;
  /**
   * Optional reference coordinate space. When provided, indexed bbox values and queryRect inputs are
   * interpreted in this element's local SVG coordinate system rather than the global SVG world space.
   */
  coordinateReferenceElement?: CoordinateReferenceElement | null;
  /**
   * Attribute names that trigger automatic invalidation.
   * Include any attributes that can affect key extraction, bbox measurement, or metadata.
   */
  observedAttributes?: string[];
  epsilon?: number;
  autoFlush?: boolean;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

const DEFAULT_OBSERVED_ATTRIBUTES = [
  'id',
  'transform',
  'style',
  'class',
  'x',
  'y',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'd',
  'points',
  'x1',
  'y1',
  'x2',
  'y2',
  'href'
] as const;

export class IndexedSvgController<TMetadata = unknown, THandle = unknown> {
  private readonly adapter: SpatialIndexAdapter<SpatialIndexItem<TMetadata>, THandle>;
  private readonly keyExtractor: (element: SVGGraphicsElement) => string | null;
  private readonly metadataExtractor: (element: SVGGraphicsElement) => TMetadata;
  private readonly coordinateReferenceElement: CoordinateReferenceElement | null;
  private readonly observedAttributes: string[];
  private readonly epsilon: number;
  private readonly autoFlush: boolean;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly listeners = new Map<EventName, Set<Listener<never>>>();
  // These three maps are the core cache: element -> record, key -> element, and pending work for the next flush.
  private readonly recordsByElement = new Map<SVGGraphicsElement, TrackedRecord<TMetadata>>();
  private readonly elementByKey = new Map<string, SVGGraphicsElement>();
  private readonly dirtyElements = new Map<SVGGraphicsElement, DirtyReason>();

  private rootElement: Element | null = null;
  private observer: MutationObserver | null = null;
  private rafHandle: number | null = null;
  private isPaused = false;
  private initialBuildPending = false;
  private handle: THandle;

  constructor(options: IndexedSvgControllerOptions<TMetadata, THandle>) {
    this.adapter = options.adapter;
    this.keyExtractor = options.keyExtractor ?? ((element) => element.id || null);
    this.metadataExtractor = options.metadataExtractor ?? (() => undefined as TMetadata);
    this.coordinateReferenceElement = options.coordinateReferenceElement ?? null;
    this.observedAttributes = [...(options.observedAttributes ?? DEFAULT_OBSERVED_ATTRIBUTES)];
    this.epsilon = options.epsilon ?? 0;
    this.autoFlush = options.autoFlush ?? true;
    this.requestFrame =
      options.requestFrame ??
      ((callback) => window.requestAnimationFrame(callback));
    this.cancelFrame =
      options.cancelFrame ??
      ((handle) => window.cancelAnimationFrame(handle));
    this.handle = this.adapter.create();
  }

  attach(rootElement: Element): void {
    if (this.rootElement === rootElement && this.observer) {
      return;
    }

    this.detach();
    this.rootElement = rootElement;
    this.initialBuildPending = true;
    this.observer = new MutationObserver((mutations) => this.handleMutations(mutations));
    this.observer.observe(rootElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeFilter: this.observedAttributes
    });

    this.scanLayerChildren(rootElement);
    this.initialBuildPending = false;
    this.scheduleFlush();
  }

  detach(): void {
    if (this.rafHandle !== null) {
      this.cancelFrame(this.rafHandle);
      this.rafHandle = null;
    }

    this.observer?.disconnect();
    this.observer = null;
    this.rootElement = null;
    this.isPaused = false;
    this.initialBuildPending = false;
    this.dirtyElements.clear();
    this.recordsByElement.clear();
    this.elementByKey.clear();
    this.adapter.dispose?.(this.handle);
    this.handle = this.adapter.create();
  }

  pause(): void {
    this.isPaused = true;
  }

  resume(): void {
    this.isPaused = false;
    this.scheduleFlush();
  }

  invalidateElement(element: SVGGraphicsElement): void {
    this.markDirty(element, 'measure');
  }

  invalidateChildren(root: Element): void {
    this.visitDirectGraphicsChildren(root, (element) => this.markDirty(element, 'measure'));
  }

  invalidateAll(): void {
    for (const element of this.recordsByElement.keys()) {
      this.markDirty(element, 'measure');
    }
  }

  flush(): FlushStats {
    if (this.rafHandle !== null) {
      this.cancelFrame(this.rafHandle);
      this.rafHandle = null;
    }

    this.emit('flushStart', undefined);

    const removes = new Set<string>();
    const upserts = new Map<string, SpatialIndexItem<TMetadata>>();
    let measured = 0;

    // A flush reconciles the dirty queue with the actual DOM, then emits one batch into the index adapter.
    for (const [element] of this.dirtyElements) {
      const currentRecord = this.recordsByElement.get(element);

      // Elements can fall out of scope because they were removed from the layer or are no longer direct children.
      if (!this.isTrackedLayerChild(element)) {
        if (currentRecord) {
          removes.add(currentRecord.key);
          this.recordsByElement.delete(element);
          this.elementByKey.delete(currentRecord.key);
        }
        continue;
      }

      const nextKey = this.keyExtractor(element);
      if (!nextKey) {
        if (currentRecord) {
          removes.add(currentRecord.key);
          this.recordsByElement.delete(element);
          this.elementByKey.delete(currentRecord.key);
        }
        continue;
      }

      if (currentRecord && currentRecord.key !== nextKey) {
        removes.add(currentRecord.key);
        this.elementByKey.delete(currentRecord.key);
      }

      const conflictingElement = this.elementByKey.get(nextKey);
      if (conflictingElement && conflictingElement !== element) {
        this.emit('error', new Error(`Duplicate spatial index key: ${nextKey}`));
        continue;
      }

      try {
        // Measurement happens as late as possible so multiple mutations in one frame collapse into one read.
        const bbox = this.measureIndexedAabb(element);
        const metadata = this.metadataExtractor(element);
        const nextRecord: TrackedRecord<TMetadata> = {
          key: nextKey,
          element,
          metadata,
          bbox
        };
        measured += 1;
        this.recordsByElement.set(element, nextRecord);
        this.elementByKey.set(nextKey, element);

        if (!currentRecord || !currentRecord.bbox || !areAabbsEqual(currentRecord.bbox, bbox, this.epsilon)) {
          upserts.set(nextKey, {
            key: nextKey,
            element,
            bbox,
            metadata
          });
        }
      } catch (error) {
        this.emit('error', error);
      }
    }

    this.dirtyElements.clear();
    const batch = {
      upserts: [...upserts.values()],
      removes: [...removes]
    };
    this.handle = this.adapter.batchUpdate(this.handle, batch);

    const stats: FlushStats = {
      measured,
      upserts: batch.upserts.length,
      removes: batch.removes.length
    };
    this.emit('flushEnd', stats);
    return stats;
  }

  queryRect(rect: WorldAabb): SpatialIndexItem<TMetadata>[] {
    const items = this.adapter.queryRect(this.handle, rect);
    const liveItems: SpatialIndexItem<TMetadata>[] = [];
    const staleKeys = new Set<string>();

    // Queries are also a safety net: if the DOM changed before observer cleanup ran, stale items are filtered out here.
    for (const item of items) {
      const currentKey = this.keyExtractor(item.element);
      if (!this.isTrackedLayerChild(item.element) || currentKey !== item.key) {
        staleKeys.add(item.key);
        this.recordsByElement.delete(item.element);
        this.elementByKey.delete(item.key);
        continue;
      }

      liveItems.push(item);
    }

    if (staleKeys.size > 0) {
      this.handle = this.adapter.batchUpdate(this.handle, {
        upserts: [],
        removes: [...staleKeys]
      });
    }

    return liveItems;
  }

  getSnapshot(): IndexedSvgSnapshot<THandle> {
    return {
      trackedCount: this.recordsByElement.size,
      queuedCount: this.dirtyElements.size,
      currentHandle: this.handle,
      isAttached: this.rootElement !== null,
      isPaused: this.isPaused,
      initialBuildPending: this.initialBuildPending
    };
  }

  on<TEventName extends EventName>(
    eventName: TEventName,
    listener: Listener<IndexedSvgEvents[TEventName]>
  ): () => void {
    const bucket = this.listeners.get(eventName) ?? new Set<Listener<never>>();
    bucket.add(listener as Listener<never>);
    this.listeners.set(eventName, bucket);
    return () => {
      bucket.delete(listener as Listener<never>);
      if (bucket.size === 0) {
        this.listeners.delete(eventName);
      }
    };
  }

  private emit<TEventName extends EventName>(eventName: TEventName, payload: IndexedSvgEvents[TEventName]): void {
    const bucket = this.listeners.get(eventName);
    if (!bucket) {
      return;
    }

    for (const listener of bucket) {
      (listener as Listener<IndexedSvgEvents[TEventName]>)(payload);
    }
  }

  private handleMutations(mutations: MutationRecord[]): void {
    // MutationObserver tells us which tracked layer children may have changed; actual measurement waits until flush.
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        if (mutation.target === this.rootElement) {
          for (const node of mutation.removedNodes) {
            if (node instanceof Element) {
              this.removeTrackedLayerChild(node);
            }
          }

          for (const node of mutation.addedNodes) {
            if (node instanceof Element) {
              this.scanLayerChild(node);
            }
          }
        } else {
          const owner = this.getTrackedLayerChildForNode(mutation.target);
          if (owner) {
            this.markDirty(owner, 'measure');
          }
        }
      }

      if (mutation.type === 'attributes') {
        const owner = this.getTrackedLayerChildForNode(mutation.target);
        if (owner) {
          this.markDirty(owner, 'measure');
        }
      }

      if (mutation.type === 'characterData') {
        const owner = this.getTrackedLayerChildForNode(mutation.target);
        if (owner) {
          this.markDirty(owner, 'measure');
        }
      }
    }

    this.scheduleFlush();
  }

  private scanLayerChildren(root: Element): void {
    this.visitDirectGraphicsChildren(root, (element) => this.markDirty(element, 'structure'));
  }

  private scanLayerChild(node: Element): void {
    if (this.isDirectGraphicsChild(node)) {
      this.markDirty(node, 'structure');
    }
  }

  private removeTrackedLayerChild(node: Element): void {
    if (this.isDirectGraphicsChild(node)) {
      this.removeTrackedElement(node);
    }
  }

  private removeTrackedElement(element: SVGGraphicsElement): void {
    const record = this.recordsByElement.get(element);
    if (!record) {
      this.dirtyElements.delete(element);
      return;
    }

    // Removals do not need layout reads, so they can be pushed into the adapter immediately.
    this.recordsByElement.delete(element);
    this.elementByKey.delete(record.key);
    this.handle = this.adapter.batchUpdate(this.handle, {
      upserts: [],
      removes: [record.key]
    });
    this.dirtyElements.delete(element);
  }

  private markDirty(element: SVGGraphicsElement, reason: DirtyReason): void {
    const previous = this.dirtyElements.get(element);
    // 'structure' means a stronger reason than a plain re-measure, so we keep it if it was already set.
    if (previous === 'structure') {
      return;
    }

    this.dirtyElements.set(element, previous ?? reason);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    // At most one frame callback is queued at a time; extra mutations just add more elements into dirtyElements.
    if (!this.autoFlush || this.isPaused || this.rafHandle !== null || this.dirtyElements.size === 0) {
      return;
    }

    this.rafHandle = this.requestFrame(() => {
      this.rafHandle = null;
      this.flush();
    });
  }

  private visitDirectGraphicsChildren(root: Element, visitor: (element: SVGGraphicsElement) => void): void {
    for (const child of root.children) {
      if (this.isDirectGraphicsChild(child)) {
        visitor(child);
      }
    }
  }

  private isDirectGraphicsChild(element: Element): element is SVGGraphicsElement {
    return element.parentElement === this.rootElement && isGraphicsElement(element);
  }

  private isTrackedLayerChild(element: SVGGraphicsElement): boolean {
    return element.parentElement === this.rootElement;
  }

  private getTrackedLayerChildForNode(node: Node | null): SVGGraphicsElement | null {
    let current: Node | null = node;

    while (current && current !== this.rootElement) {
      if (current instanceof Element && this.isDirectGraphicsChild(current)) {
        return current;
      }
      current = current.parentNode;
    }

    return null;
  }

  private measureIndexedAabb(element: SVGGraphicsElement): WorldAabb {
    const localBBox = element.getBBox();
    const matrix = element.getCTM();
    if (!matrix) {
      throw new Error(`Unable to measure CTM for element: ${element.id || element.tagName}`);
    }

    const referenceMatrix = this.coordinateReferenceElement?.getCTM() ?? null;
    if (this.coordinateReferenceElement && !referenceMatrix) {
      throw new Error('Unable to measure CTM for coordinate reference element.');
    }

    // We index in one shared coordinate space: world by default, or a caller-selected SVG reference element.
    return toAabbInCoordinateSpace(localBBox, matrix, referenceMatrix ?? undefined);
  }
}

function isGraphicsElement(element: Node | null): element is SVGGraphicsElement {
  if (!(element instanceof SVGElement)) {
    return false;
  }

  const candidate = element as Partial<GraphicsElementLike>;
  return typeof candidate.getBBox === 'function' && typeof candidate.getCTM === 'function';
}