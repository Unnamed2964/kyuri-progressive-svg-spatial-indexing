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
  return toAabbInCoordinateSpace(box, matrix);
}

export function toAabbInCoordinateSpace(
  box: BBoxLike,
  matrix: MatrixLike,
  referenceMatrix?: MatrixLike
): WorldAabb {
  // A rotated or skewed box is no longer axis-aligned, so we transform all four corners and re-wrap them.
  const effectiveMatrix = referenceMatrix
    ? multiplyMatrices(invertMatrix(referenceMatrix), matrix)
    : matrix;
  const points = [
    transformPoint(box.x, box.y, effectiveMatrix),
    transformPoint(box.x + box.width, box.y, effectiveMatrix),
    transformPoint(box.x + box.width, box.y + box.height, effectiveMatrix),
    transformPoint(box.x, box.y + box.height, effectiveMatrix)
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

export function invertMatrix(matrix: MatrixLike): MatrixLike {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (determinant === 0) {
    throw new Error('Unable to invert matrix with zero determinant.');
  }

  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant
  };
}

export function multiplyMatrices(left: MatrixLike, right: MatrixLike): MatrixLike {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f
  };
}