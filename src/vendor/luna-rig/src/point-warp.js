/** Thin plate spline weights bind a painted palm to its real knuckle roots.
 * The inverse system and each mesh vertex's weights are computed once.
 */
function inverse(input) {
  const n = input.length,
    a = input.map((row, i) => [
      ...row,
      ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
    ]);
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let i = k + 1; i < n; i++)
      if (Math.abs(a[i][k]) > Math.abs(a[pivot][k])) pivot = i;
    [a[k], a[pivot]] = [a[pivot], a[k]];
    if (Math.abs(a[k][k]) < 1e-12)
      throw new Error("Degenerate native palm anchors");
    const divisor = a[k][k];
    for (let j = 0; j < 2 * n; j++) a[k][j] /= divisor;
    for (let i = 0; i < n; i++)
      if (i !== k) {
        const factor = a[i][k];
        for (let j = 0; j < 2 * n; j++) a[i][j] -= factor * a[k][j];
      }
  }
  return a.map((row) => row.slice(n));
}
const kernel = (r2) => (r2 > 1e-12 ? r2 * Math.log(r2) : 0);
export function pointWarp(anchors) {
  const n = anchors.length,
    points = anchors.map(([x, y]) => [x / 100, y / 100]);
  const matrix = Array.from({ length: n + 3 }, () => Array(n + 3).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++)
      matrix[i][j] = kernel(
        (points[i][0] - points[j][0]) ** 2 + (points[i][1] - points[j][1]) ** 2,
      );
    [matrix[i][n], matrix[i][n + 1], matrix[i][n + 2]] = [1, ...points[i]];
    matrix[n][i] = 1;
    matrix[n + 1][i] = points[i][0];
    matrix[n + 2][i] = points[i][1];
  }
  const coefficients = inverse(matrix);
  return {
    weights(x, y) {
      x /= 100;
      y /= 100;
      const basis = [
        ...points.map(([a, b]) => kernel((x - a) ** 2 + (y - b) ** 2)),
        1,
        x,
        y,
      ];
      return Array.from({ length: n }, (_, i) =>
        basis.reduce((sum, value, j) => sum + value * coefficients[j][i], 0),
      );
    },
    point(x, y, weights, targets) {
      let dx = 0,
        dy = 0;
      for (let i = 0; i < n; i++) {
        dx += weights[i] * (targets[i][0] - anchors[i][0]);
        dy += weights[i] * (targets[i][1] - anchors[i][1]);
      }
      return [x + dx, y + dy];
    },
  };
}
