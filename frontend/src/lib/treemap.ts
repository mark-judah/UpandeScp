/** Squarified treemap layout (Bruls, Huizing, van Wijk). Pure, no DOM. */
export interface TreemapInput {
  id: string;
  value: number;
}
export interface TreemapRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function worst(row: number[], side: number): number {
  const s = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
}

/** Lay `items` (any order, values > 0) out inside the x/y/w/h box. Rects are
 *  returned largest-first and tile the box exactly. Non-positive values are
 *  dropped. */
export function squarify(
  items: TreemapInput[],
  box: { x: number; y: number; w: number; h: number },
): TreemapRect[] {
  const list = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = list.reduce((s, i) => s + i.value, 0);
  if (!list.length || box.w <= 0 || box.h <= 0) return [];
  const scale = (box.w * box.h) / total;
  const areas = list.map((i) => i.value * scale);
  const out: TreemapRect[] = [];
  let { x, y, w, h } = box;
  let i = 0;
  while (i < list.length) {
    const side = Math.min(w, h);
    let row = [areas[i]];
    let j = i + 1;
    while (j < list.length && worst([...row, areas[j]], side) <= worst(row, side)) {
      row.push(areas[j]);
      j += 1;
    }
    const rowSum = row.reduce((a, b) => a + b, 0);
    if (w >= h) {
      const colW = rowSum / h;
      let cy = y;
      row.forEach((a, k) => {
        const rh = a / colW;
        out.push({ id: list[i + k].id, x, y: cy, w: colW, h: rh });
        cy += rh;
      });
      x += colW;
      w -= colW;
    } else {
      const rowH = rowSum / w;
      let cx = x;
      row.forEach((a, k) => {
        const rw = a / rowH;
        out.push({ id: list[i + k].id, x: cx, y, w: rw, h: rowH });
        cx += rw;
      });
      y += rowH;
      h -= rowH;
    }
    i = j;
    row = [];
  }
  return out;
}
