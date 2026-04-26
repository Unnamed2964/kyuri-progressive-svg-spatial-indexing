export interface WorldAabb {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SpatialIndexItem<TMeta = unknown> {
  key: string;
  element: SVGGraphicsElement;
  /**
   * Axis-aligned bounds in the controller's index coordinate space.
   * By default this is SVG world space; when coordinateReferenceElement is set, it becomes that
   * element's local coordinate system.
   */
  bbox: WorldAabb;
  metadata: TMeta;
}

export interface BatchUpdate<TItem> {
  upserts: TItem[];
  removes: string[];
}

export interface FlushStats {
  measured: number;
  upserts: number;
  removes: number;
}

export interface IndexedSvgSnapshot<THandle = unknown> {
  trackedCount: number;
  queuedCount: number;
  currentHandle: THandle;
  isAttached: boolean;
  isPaused: boolean;
  initialBuildPending: boolean;
}

export interface IndexedSvgEvents {
  flushStart: void;
  flushEnd: FlushStats;
  error: unknown;
}