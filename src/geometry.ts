import type { WorldAabb } from './types.js';

export interface BBoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MatrixLike {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

interface Point {
  x: number;
  y: number;
}

export function toWorldAabb(box: BBoxLike, matrix: MatrixLike): WorldAabb {
  // A rotated or skewed box is no longer axis-aligned, so we transform all four corners and re-wrap them.
  const points = [
    transformPoint(box.x, box.y, matrix),
    transformPoint(box.x + box.width, box.y, matrix),
    transformPoint(box.x + box.width, box.y + box.height, matrix),
    transformPoint(box.x, box.y + box.height, matrix)
  ];

  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y))
  };
}

export function areAabbsEqual(left: WorldAabb, right: WorldAabb, epsilon: number): boolean {
  // epsilon avoids churn from tiny float differences that are irrelevant to broad-phase queries.
  return (
    Math.abs(left.minX - right.minX) <= epsilon &&
    Math.abs(left.minY - right.minY) <= epsilon &&
    Math.abs(left.maxX - right.maxX) <= epsilon &&
    Math.abs(left.maxY - right.maxY) <= epsilon
  );
}

function transformPoint(x: number, y: number, matrix: MatrixLike): Point {
  return {
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f
  };
}