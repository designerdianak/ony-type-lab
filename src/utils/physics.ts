/** Простое разрешение перекрытий AABB (круговое приближение). */
export function separateDiscs(
  xs: Float32Array,
  ys: Float32Array,
  rs: Float32Array,
  minGap: number,
  iterations = 3,
) {
  const n = xs.length;
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = xs[j]! - xs[i]!;
        const dy = ys[j]! - ys[i]!;
        const dist = Math.hypot(dx, dy) || 0.0001;
        const minDist = rs[i]! + rs[j]! + minGap;
        if (dist < minDist) {
          const push = (minDist - dist) * 0.5;
          const nx = dx / dist;
          const ny = dy / dist;
          xs[i] = xs[i]! - nx * push;
          ys[i] = ys[i]! - ny * push;
          xs[j] = xs[j]! + nx * push;
          ys[j] = ys[j]! + ny * push;
        }
      }
    }
  }
}
