/** WebGL availability check.
 *
 *  Lives apart from Terrain3D so callers can gate the 3D toggle without
 *  statically importing three.js — that import alone pulls a ~508 kB chunk,
 *  which the 2D heatmap path must not pay for.
 */
export function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(
      window.WebGLRenderingContext &&
      (c.getContext("webgl2") || c.getContext("webgl"))
    );
  } catch {
    return false;
  }
}
