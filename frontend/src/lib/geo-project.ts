/** Forward projection (lng/lat → SVG space) recovered from a geometry's exact
 *  `unproject`. The projection is affine, so three probes pin it down. */
export type Unproject = (x: number, y: number) => [number, number];

export function projectFromUnproject(unproject: Unproject): ((lng: number, lat: number) => [number, number]) | null {
  const [l0, a0] = unproject(0, 0);
  const [l1, a1] = unproject(1, 0);
  const [l2, a2] = unproject(0, 1);
  // [dLng dLat] = M · [dx dy]; M columns are the probe deltas.
  const m11 = l1 - l0, m21 = a1 - a0, m12 = l2 - l0, m22 = a2 - a0;
  const det = m11 * m22 - m12 * m21;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null;
  return (lng, lat) => {
    const dl = lng - l0, da = lat - a0;
    return [(m22 * dl - m12 * da) / det, (-m21 * dl + m11 * da) / det];
  };
}
