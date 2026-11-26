/**
 * The whole farm's Hexas and full triangles, drawn by the GPU as instances (a MapLibre custom
 * WebGL2 layer).
 *
 * Each full triangle is one instance of a single 3-vertex triangle: per instance only its hexa
 * centre (lattice metres, float32) and slot; the corners come from the slot in the vertex shader
 * ([centre, V(30°+60°(t-1)), V(30°+60°t)], as hexa_grid.cut). Each Hexa outline is one instance of
 * a 12-vertex line set (its six outer edges; an edge whose triangle is not full collapses). A block
 * is drawn with its own lattice → Web-Mercator affine as a uniform, relative to a farm reference
 * point so float32 keeps millimetres. Colour is a per-instance RGBA buffer: a recolour rewrites
 * bytes, never geometry. The clipped edge pieces are a small GeoJSON layer (field-layers).
 *
 * Fades mirror the flicker fix: each layer ramps in over FADE_DZ zoom before its threshold.
 */
import maplibregl from "maplibre-gl";
import type { HeldLattice } from "@/lib/field-geo";
import { FADE_DZ, HEXA_LINE_ZOOM, TRI_LINE_ZOOM, UNSCOUTED_TRI } from "./field-layers";

export const LATTICE_LAYER_ID = "fg-lattice";
const C = 2 * Math.PI * 6378137; // Web-Mercator metres per mercator unit
const VISITED_ALPHA = 0.88;
const UNSCOUTED_ALPHA = 0.28;
const HEXA_ALPHA = 0.55;
const TRI_LINE_ALPHA = 0.35;

/** "#rgb", "#rrggbb" or "rgba(r,g,b,a)" -> [r, g, b, alpha 0..1]. The tone bands are rgba strings:
 *  their alpha is the strength step. */
export function parseColor(c: string): [number, number, number, number] {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c.trim());
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : Math.min(1, Math.max(0, +m[4]))];
  const h = c.replace("#", "");
  const v = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h.slice(0, 6), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 1];
}
function hexRgb(hex: string): [number, number, number] {
  const [r, g, b] = parseColor(hex);
  return [r, g, b];
}
const UNSCOUTED_RGB = hexRgb(UNSCOUTED_TRI);

/** 0 at z - FADE_DZ, 1 at z. */
export function fade(zoom: number, z: number): number {
  return Math.min(1, Math.max(0, (zoom - (z - FADE_DZ)) / FADE_DZ));
}

const VS_TRI = `#version 300 es
in vec2 a_c; in float a_t; in vec4 a_col;
uniform mat4 u_m; uniform mat2 u_lin; uniform vec2 u_o; uniform float u_side; uniform float u_alpha;
out vec4 v_col;
void main() {
  int v = gl_VertexID;
  vec2 p = a_c;
  if (v > 0) { float a = radians(30.0 + 60.0 * (a_t - 1.0 + float(v - 1))); p += u_side * vec2(cos(a), sin(a)); }
  gl_Position = u_m * vec4(u_o + u_lin * p, 0.0, 1.0);
  v_col = vec4(a_col.rgb * a_col.a * u_alpha, a_col.a * u_alpha);
}`;

// Triangle outline: 3 segments = 6 vertices per instance, corners [C, Va, Vb].
const VS_TRI_LINE = `#version 300 es
in vec2 a_c; in float a_t;
uniform mat4 u_m; uniform mat2 u_lin; uniform vec2 u_o; uniform float u_side;
void main() {
  int seg = gl_VertexID / 2; int end = gl_VertexID - seg * 2;
  int v = (seg + end) - ((seg + end) / 3) * 3; // 0,1 | 1,2 | 2,0
  vec2 p = a_c;
  if (v > 0) { float a = radians(30.0 + 60.0 * (a_t - 1.0 + float(v - 1))); p += u_side * vec2(cos(a), sin(a)); }
  gl_Position = u_m * vec4(u_o + u_lin * p, 0.0, 1.0);
}`;

// Hexa outline: 6 edges = 12 vertices per instance; edge k is drawn when slot k+1 is a full triangle.
const VS_HEXA = `#version 300 es
in vec2 a_c; in float a_mask;
uniform mat4 u_m; uniform mat2 u_lin; uniform vec2 u_o; uniform float u_side;
void main() {
  int seg = gl_VertexID / 2; int end = gl_VertexID - seg * 2;
  vec2 p = a_c;
  int m = int(a_mask + 0.5);
  if (((m >> seg) & 1) == 1) { float a = radians(30.0 + 60.0 * float(seg + end)); p += u_side * vec2(cos(a), sin(a)); }
  gl_Position = u_m * vec4(u_o + u_lin * p, 0.0, 1.0);
}`;

const FS_VARYING = `#version 300 es
precision mediump float; in vec4 v_col; out vec4 o;
void main() { o = v_col; }`;
const FS_UNIFORM = `#version 300 es
precision mediump float; uniform vec4 u_col; out vec4 o;
void main() { o = u_col; }`;

interface GpuBlock {
  held: HeldLattice;
  nTri: number;
  nHex: number;
  colors: Uint8Array;
  dirty: boolean;
  lin: Float32Array; // mat2, column-major
  o: Float32Array; // block origin (mercator units) minus the farm reference
  side: number;
  merc: [number, number, number, number]; // mercator box for culling
  vaoTri?: WebGLVertexArrayObject | null;
  vaoTriLine?: WebGLVertexArrayObject | null;
  vaoHex?: WebGLVertexArrayObject | null;
  colorBuf?: WebGLBuffer | null;
  bufs: WebGLBuffer[];
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || "shader");
    gl.attachShader(p, sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link");
  return p;
}

export class FieldLatticeLayer implements maplibregl.CustomLayerInterface {
  id = LATTICE_LAYER_ID;
  type = "custom" as const;
  renderingMode = "2d" as const;

  private map: maplibregl.Map | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private blocks: GpuBlock[] = [];
  private pending: GpuBlock[] = [];
  private ref: [number, number] | null = null;
  private byHeld = new Map<HeldLattice, GpuBlock>();
  private progTri: WebGLProgram | null = null;
  private progTriLine: WebGLProgram | null = null;
  private progHex: WebGLProgram | null = null;
  private visible = { tri: true, hexa: true };
  /** Last frame's time (ms) and a rolling count, for the measurements. */
  frameMs = 0;

  /** Alpha of a triangle with no colour: faint by default, 0 where only findings should show. */
  private unscoutedAlpha = UNSCOUTED_ALPHA;

  constructor(
    private triZoom: number,
    private hexaZoom = HEXA_LINE_ZOOM,
    unscoutedAlpha = UNSCOUTED_ALPHA,
  ) {
    this.unscoutedAlpha = unscoutedAlpha;
  }

  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    if (!(typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext)) {
      console.warn("[field] WebGL2 unavailable: Hexas and triangles are not drawn");
      return;
    }
    this.gl = gl;
    this.progTri = compile(gl, VS_TRI, FS_VARYING);
    this.progTriLine = compile(gl, VS_TRI_LINE, FS_UNIFORM);
    this.progHex = compile(gl, VS_HEXA, FS_UNIFORM);
    for (const b of this.pending) this.upload(b);
    this.blocks.push(...this.pending);
    this.pending = [];
  }

  onRemove(): void {
    const gl = this.gl;
    if (gl) {
      for (const b of this.blocks) {
        for (const buf of b.bufs) gl.deleteBuffer(buf);
        for (const v of [b.vaoTri, b.vaoTriLine, b.vaoHex]) if (v) gl.deleteVertexArray(v);
      }
      for (const p of [this.progTri, this.progTriLine, this.progHex]) if (p) gl.deleteProgram(p);
    }
    this.blocks = [];
    this.byHeld.clear();
    this.gl = null;
    this.map = null;
  }

  setVisible(v: { tri: boolean; hexa: boolean }): void {
    this.visible = v;
    this.map?.triggerRepaint();
  }

  setTriZoom(z: number): void {
    this.triZoom = z;
    this.map?.triggerRepaint();
  }

  get triangleCount(): number {
    return [...this.blocks, ...this.pending].reduce((n, b) => n + b.nTri, 0);
  }

  /** Add loaded blocks (their buffers go to the GPU at once, or on add if the layer is not on yet). */
  addBlocks(held: HeldLattice[]): void {
    for (const h of held) {
      const enc = h.enc;
      if (!enc.aff || !h.cells.n) continue;
      const a = enc.aff;
      const ox = (a[2] + C / 2) / C;
      const oy = (C / 2 - a[5]) / C;
      if (!this.ref) this.ref = [ox, oy];
      let nTri = 0;
      for (let i = 0; i < h.cells.n; i++) for (let f = h.cells.full[i]; f; f &= f - 1) nTri++;
      const b: GpuBlock = {
        held: h,
        nTri,
        nHex: 0,
        colors: new Uint8Array(nTri * 4),
        dirty: false,
        // ideal metres -> mercator units (y flips: Web-Mercator Y grows north, mercator y south)
        lin: new Float32Array([a[0] / C, -a[3] / C, a[1] / C, -a[4] / C]),
        o: new Float32Array([ox - this.ref[0], oy - this.ref[1]]),
        side: enc.side ?? 5,
        merc: [0, 0, 0, 0],
        bufs: [],
      };
      this.byHeld.set(h, b);
      for (let k = 0; k < nTri; k++) {
        b.colors.set(UNSCOUTED_RGB, k * 4);
        b.colors[k * 4 + 3] = Math.round(this.unscoutedAlpha * 255);
      }
      const [w, s, e, n] = h.box;
      const mx = (lng: number) => (lng + 180) / 360;
      const my = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
      b.merc = [mx(w), my(n), mx(e), my(s)];
      if (this.gl) {
        this.upload(b);
        this.blocks.push(b);
      } else this.pending.push(b);
    }
    this.map?.triggerRepaint();
  }

  private upload(b: GpuBlock): void {
    const gl = this.gl!;
    const { cells } = b.held;
    const tri = new Float32Array(b.nTri * 3);
    let k = 0;
    for (let i = 0; i < cells.n; i++)
      for (let t = 1; t <= 6; t++)
        if ((cells.full[i] >> (t - 1)) & 1) {
          tri[k * 3] = cells.x[i];
          tri[k * 3 + 1] = cells.y[i];
          tri[k * 3 + 2] = t;
          k++;
        }
    const hexList: number[] = [];
    for (let i = 0; i < cells.n; i++) if (cells.full[i]) hexList.push(cells.x[i], cells.y[i], cells.full[i]);
    b.nHex = hexList.length / 3;
    const mk = (data: ArrayBufferView, usage: number) => {
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      b.bufs.push(buf);
      return buf;
    };
    const triBuf = mk(tri, gl.STATIC_DRAW);
    b.colorBuf = mk(b.colors, gl.DYNAMIC_DRAW);
    const hexBuf = mk(new Float32Array(hexList), gl.STATIC_DRAW);
    const attr = (prog: WebGLProgram, name: string, buf: WebGLBuffer, size: number, type: number, norm: boolean, stride: number, off: number) => {
      const loc = gl.getAttribLocation(prog, name);
      if (loc < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, norm, stride, off);
      gl.vertexAttribDivisor(loc, 1);
    };
    b.vaoTri = gl.createVertexArray();
    gl.bindVertexArray(b.vaoTri);
    attr(this.progTri!, "a_c", triBuf, 2, gl.FLOAT, false, 12, 0);
    attr(this.progTri!, "a_t", triBuf, 1, gl.FLOAT, false, 12, 8);
    attr(this.progTri!, "a_col", b.colorBuf, 4, gl.UNSIGNED_BYTE, true, 4, 0);
    b.vaoTriLine = gl.createVertexArray();
    gl.bindVertexArray(b.vaoTriLine);
    attr(this.progTriLine!, "a_c", triBuf, 2, gl.FLOAT, false, 12, 0);
    attr(this.progTriLine!, "a_t", triBuf, 1, gl.FLOAT, false, 12, 8);
    b.vaoHex = gl.createVertexArray();
    gl.bindVertexArray(b.vaoHex);
    attr(this.progHex!, "a_c", hexBuf, 2, gl.FLOAT, false, 12, 0);
    attr(this.progHex!, "a_mask", hexBuf, 1, gl.FLOAT, false, 12, 8);
    gl.bindVertexArray(null);
  }

  /** Colour one full triangle (its block, instance index); ``null`` = unscouted. Applied on the next frame. */
  setColor(held: HeldLattice, i: number, hex: string | null): void {
    const b = this.byHeld.get(held);
    if (!b || i >= b.nTri) return;
    const [r, g, bl, a] = hex ? parseColor(hex) : [...UNSCOUTED_RGB, 1];
    b.colors.set([r, g, bl], i * 4);
    b.colors[i * 4 + 3] = Math.round((hex ? VISITED_ALPHA * a : this.unscoutedAlpha) * 255);
    b.dirty = true;
  }

  repaint(): void {
    this.map?.triggerRepaint();
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: unknown): void {
    const g = this.gl;
    const map = this.map;
    if (!g || !map || !this.ref || !this.blocks.length) return;
    const t0 = performance.now();
    const a = args as { defaultProjectionData?: { mainMatrix?: ArrayLike<number> }; matrix?: ArrayLike<number> };
    const M = a?.defaultProjectionData?.mainMatrix ?? a?.matrix ?? (Array.isArray(args) ? (args as number[]) : null);
    if (!M || M.length !== 16) return;
    const zoom = map.getZoom();
    const fTri = this.visible.tri ? fade(zoom, this.triZoom) : 0;
    const fLine = this.visible.tri ? fade(zoom, Math.max(TRI_LINE_ZOOM, this.triZoom)) : 0;
    const fHex = this.visible.hexa ? fade(zoom, this.hexaZoom) : 0;
    if (!fTri && !fHex) return;
    // u_m = M · translate(ref), in float64, then float32: offsets stay small and exact.
    const [rx, ry] = this.ref;
    const m = new Float32Array(16);
    for (let i = 0; i < 12; i++) m[i] = M[i];
    for (let r = 0; r < 4; r++) m[12 + r] = M[r] * rx + M[4 + r] * ry + M[12 + r];
    // Cull blocks off screen (mercator box against the padded view).
    const bnd = map.getBounds();
    const mx = (lng: number) => (lng + 180) / 360;
    const my = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360)) / Math.PI) / 2;
    const vw = [mx(bnd.getWest()), my(bnd.getNorth()), mx(bnd.getEast()), my(bnd.getSouth())];
    const inView = (b: GpuBlock) => !(b.merc[2] < vw[0] || b.merc[0] > vw[2] || b.merc[3] < vw[1] || b.merc[1] > vw[3]);

    g.disable(g.DEPTH_TEST);
    g.disable(g.STENCIL_TEST);
    g.disable(g.CULL_FACE);
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    const uniforms = (p: WebGLProgram, b: GpuBlock) => {
      g.uniformMatrix4fv(g.getUniformLocation(p, "u_m"), false, m);
      g.uniformMatrix2fv(g.getUniformLocation(p, "u_lin"), false, b.lin);
      g.uniform2fv(g.getUniformLocation(p, "u_o"), b.o);
      g.uniform1f(g.getUniformLocation(p, "u_side"), b.side);
    };
    const shown = this.blocks.filter(inView);
    if (fTri > 0) {
      g.useProgram(this.progTri);
      g.uniform1f(g.getUniformLocation(this.progTri!, "u_alpha"), fTri);
      for (const b of shown) {
        if (b.dirty && b.colorBuf) {
          g.bindBuffer(g.ARRAY_BUFFER, b.colorBuf);
          g.bufferSubData(g.ARRAY_BUFFER, 0, b.colors);
          b.dirty = false;
        }
        uniforms(this.progTri!, b);
        g.bindVertexArray(b.vaoTri!);
        g.drawArraysInstanced(g.TRIANGLES, 0, 3, b.nTri);
      }
    }
    if (fLine > 0) {
      g.useProgram(this.progTriLine);
      const al = TRI_LINE_ALPHA * fLine;
      g.uniform4f(g.getUniformLocation(this.progTriLine!, "u_col"), (0x2a / 255) * al, (0x2a / 255) * al, (0x26 / 255) * al, al);
      for (const b of shown) {
        uniforms(this.progTriLine!, b);
        g.bindVertexArray(b.vaoTriLine!);
        g.drawArraysInstanced(g.LINES, 0, 6, b.nTri);
      }
    }
    if (fHex > 0) {
      g.useProgram(this.progHex);
      const al = HEXA_ALPHA * fHex;
      g.uniform4f(g.getUniformLocation(this.progHex!, "u_col"), (0x2a / 255) * al, (0x2a / 255) * al, (0x26 / 255) * al, al);
      for (const b of shown) {
        uniforms(this.progHex!, b);
        g.bindVertexArray(b.vaoHex!);
        g.drawArraysInstanced(g.LINES, 0, 12, b.nHex);
      }
    }
    g.bindVertexArray(null);
    this.frameMs = performance.now() - t0;
    void gl;
  }
}
