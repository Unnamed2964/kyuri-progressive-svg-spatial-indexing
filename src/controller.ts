import type { SpatialIndexAdapter } from './adapter.js';
import { areAabbsEqual, toWorldAabb } from './geometry.js';
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

export interface IndexedSvgControllerOptions<TMetadata, THandle> {
  adapter: SpatialIndexAdapter<SpatialIndexItem<TMetadata>, THandle>;
  matcher?: (element: Element) => boolean;
  keyExtractor?: (element: SVGGraphicsElement) => string | null;
  metadataExtractor?: (element: SVGGraphicsElement) => TMetadata;
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
  private readonly matcher: (element: Element) => boolean;
  private readonly keyExtractor: (element: SVGGraphicsElement) => string | null;
  private readonly metadataExtractor: (element: SVGGraphicsElement) => TMetadata;
  private readonly observedAttributes: string[];
  private readonly epsilon: number;
  private readonly autoFlush: boolean;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly listeners = new Map<EventName, Set<Listener<never>>>();
  private readonly recordsByElement = new Map<SVGGraphicsElement, TrackedRecord<TMetadata>>();
  private readonly elementByKey = new Map<string, SVGGraphicsElement>();
  private readonly dirtyElements = new Map<SVGGraphicsElement, DirtyReason>();

  private svgRoot: SVGSVGElement | null = null;
  private observer: MutationObserver | null = null;
  private rafHandle: number | null = null;
  private isPaused = false;
  private initialBuildPending = false;
  private handle: THandle;

  constructor(options: IndexedSvgControllerOptions<TMetadata, THandle>) {
    this.adapter = options.adapter;
    this.matcher = options.matcher ?? defaultMatcher;
    this.keyExtractor = options.keyExtractor ?? ((element) => element.id || null);
    this.metadataExtractor = options.metadataExtractor ?? (() => undefined as TMetadata);
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

  attach(svgRoot: SVGSVGElement): void {
    if (this.svgRoot === svgRoot && this.observer) {
      return;
    }

    this.detach();
    this.svgRoot = svgRoot;
    this.initialBuildPending = true;
    this.observer = new MutationObserver((mutations) => this.handleMutations(mutations));
    this.observer.observe(svgRoot, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeFilter: this.observedAttributes
    });

    this.scanSubtree(svgRoot);
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
    this.svgRoot = null;
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

  invalidateSubtree(root: Element): void {
    this.visitMatchingGraphics(root, (element) => this.markDirty(element, 'measure'));
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

    for (const [element] of this.dirtyElements) {
      const currentRecord = this.recordsByElement.get(element);

      if (!this.svgRoot?.contains(element) || !this.matchesElement(element)) {
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
        const bbox = this.measureWorldAabb(element);
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

    for (const item of items) {
      const currentKey = this.keyExtractor(item.element);
      if (!this.svgRoot?.contains(item.element) || !this.matchesElement(item.element) || currentKey !== item.key) {
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
      isAttached: this.svgRoot !== null,
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
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.removedNodes) {
          if (node instanceof Element) {
            this.removeTrackedSubtree(node);
          }
        }

        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            this.scanSubtree(node);
          }
        }
      }

      if (mutation.type === 'attributes') {
        const target = mutation.target;
        if (isGraphicsElement(target)) {
          this.markDirty(target, 'measure');
        }

        if (target instanceof Element) {
          this.invalidateSubtree(target);
        }
      }

      if (mutation.type === 'characterData') {
        const parentElement = mutation.target.parentElement;
        if (parentElement) {
          this.invalidateSubtree(parentElement);
        }
      }
    }

    this.scheduleFlush();
  }

  private scanSubtree(root: Element): void {
    this.visitMatchingGraphics(root, (element) => this.markDirty(element, 'structure'));
  }

  private removeTrackedSubtree(root: Element): void {
    if (root instanceof SVGGraphicsElement) {
      this.removeTrackedElement(root);
    }

    this.visitMatchingGraphics(root, (element) => {
      if (element !== root) {
        this.removeTrackedElement(element);
      }
    });
  }

  private removeTrackedElement(element: SVGGraphicsElement): void {
    const record = this.recordsByElement.get(element);
    if (!record) {
      this.dirtyElements.delete(element);
      return;
    }

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
    if (previous === 'structure') {
      return;
    }

    this.dirtyElements.set(element, previous ?? reason);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.autoFlush || this.isPaused || this.rafHandle !== null || this.dirtyElements.size === 0) {
      return;
    }

    this.rafHandle = this.requestFrame(() => {
      this.rafHandle = null;
      this.flush();
    });
  }

  private visitMatchingGraphics(root: Element, visitor: (element: SVGGraphicsElement) => void): void {
    if (isGraphicsElement(root) && this.matchesElement(root)) {
      visitor(root);
    }

    for (const element of root.querySelectorAll('*')) {
      if (isGraphicsElement(element) && this.matchesElement(element)) {
        visitor(element);
      }
    }
  }

  private matchesElement(element: Element): element is SVGGraphicsElement {
    return isGraphicsElement(element) && this.matcher(element);
  }

  private measureWorldAabb(element: SVGGraphicsElement): WorldAabb {
    const localBBox = element.getBBox();
    const matrix = element.getCTM();
    if (!matrix) {
      throw new Error(`Unable to measure CTM for element: ${element.id || element.tagName}`);
    }

    return toWorldAabb(localBBox, matrix);
  }
}

function defaultMatcher(element: Element): boolean {
  return isGraphicsElement(element) && Boolean(element.id);
}

function isGraphicsElement(element: Node | null): element is SVGGraphicsElement {
  if (!(element instanceof SVGElement)) {
    return false;
  }

  const candidate = element as Partial<GraphicsElementLike>;
  return typeof candidate.getBBox === 'function' && typeof candidate.getCTM === 'function';
}