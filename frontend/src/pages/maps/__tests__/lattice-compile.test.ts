/**
 * The lattice layer never waits for its shaders on the main thread: onAdd only starts the
 * compiles, and render draws nothing (asking again next frame) until the driver says they are
 * done. Waiting in onAdd was seconds on a software GL, ahead of the farm's download.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FieldLatticeLayer, programStatus, startProgram } from "../FieldLatticeLayer";
import { latticeCells, type HeldLattice, type LatticeBlock } from "@/lib/field-geo";

const BLOCKING = ["getShaderParameter", "getProgramParameter", "getAttribLocation", "getUniformLocation"];

/** A WebGL2 stand-in: records every call; ``done`` = whether the "driver" finished compiling. */
function fakeGl(state: { done: boolean; parallel: boolean; linkOk?: boolean }) {
  const calls: string[] = [];
  class FakeGL2 {}
  (globalThis as unknown as { WebGL2RenderingContext: unknown }).WebGL2RenderingContext = FakeGL2;
  const gl = Object.create(FakeGL2.prototype);
  const consts: Record<string, number> = { VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, LINK_STATUS: 3, ARRAY_BUFFER: 4, FLOAT: 5, UNSIGNED_BYTE: 6, STATIC_DRAW: 7, DYNAMIC_DRAW: 8, TRIANGLES: 9, LINES: 10 };
  const impl: Record<string, (...a: unknown[]) => unknown> = {
    getExtension: (n) => (n === "KHR_parallel_shader_compile" && state.parallel ? {} : null),
    getProgramParameter: (_p, pname) => (pname === 0x91b1 ? state.done : state.linkOk !== false),
    getAttachedShaders: () => [],
    getUniformLocation: (_p, n) => ({ n }),
  };
  return {
    calls,
    gl: new Proxy(gl, {
      get(t, k: string) {
        if (k in consts) return consts[k];
        if (k === "constructor" || typeof k === "symbol") return Reflect.get(t, k);
        return (...a: unknown[]) => {
          calls.push(k);
          return impl[k] ? impl[k](...a) : {};
        };
      },
    }) as unknown as WebGL2RenderingContext,
  };
}

function fakeMap() {
  return {
    getZoom: () => 19,
    getBounds: () => ({ getWest: () => -180, getEast: () => 180, getNorth: () => 80, getSouth: () => -80 }),
    triggerRepaint: vi.fn(),
  };
}

function held(): HeldLattice {
  const enc: LatticeBlock = { side: 5, aff: [1, 0, 0, 0, 1, 0], h: [0, 0, 63 | (63 << 6)], e: [], x: [] };
  return { name: "B", enc, cells: latticeCells(enc), inst: new Map(), clip: new Map(), clipSource: "s", byNo: new Map(), box: [-1, -1, 1, 1] };
}

const M = { defaultProjectionData: { mainMatrix: new Float32Array(16).fill(1) } };

describe("lattice layer shader compile", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    delete (globalThis as unknown as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext;
  });

  it("startProgram compiles and links without asking for the result", () => {
    const { gl, calls } = fakeGl({ done: false, parallel: true });
    startProgram(gl, "vs", "fs");
    expect(calls).toContain("linkProgram");
    expect(calls.filter((c) => BLOCKING.includes(c))).toEqual([]);
  });

  it("programStatus is pending while the driver compiles, ok once linked, and throws on a failed link", () => {
    const st = { done: false, parallel: true };
    const { gl } = fakeGl(st);
    expect(programStatus(gl, {} as WebGLProgram, true)).toBe("pending");
    st.done = true;
    expect(programStatus(gl, {} as WebGLProgram, true)).toBe("ok");
    const bad = fakeGl({ done: true, parallel: true, linkOk: false });
    expect(() => programStatus(bad.gl, {} as WebGLProgram, true)).toThrow();
  });

  it("onAdd + uploading blocks never blocks on the GPU; render waits for the compile, then draws", () => {
    const st = { done: false, parallel: true };
    const { gl, calls } = fakeGl(st);
    const map = fakeMap();
    const layer = new FieldLatticeLayer(17);
    layer.addBlocks([held()]);
    layer.onAdd(map as never, gl);
    expect(calls.filter((c) => BLOCKING.includes(c))).toEqual([]);
    expect(layer.triangleCount).toBe(6);

    layer.render(gl, M);
    expect(calls).not.toContain("drawArraysInstanced");
    expect(map.triggerRepaint).toHaveBeenCalled();

    st.done = true;
    layer.render(gl, M);
    expect(calls).toContain("drawArraysInstanced");
    // uniform locations are looked up once, not per block per frame
    const n = calls.filter((c) => c === "getUniformLocation").length;
    layer.render(gl, M);
    expect(calls.filter((c) => c === "getUniformLocation").length).toBe(n);
  });

  it("a failed link turns the layer off instead of throwing every frame", () => {
    const { gl, calls } = fakeGl({ done: true, parallel: true, linkOk: false });
    const layer = new FieldLatticeLayer(17);
    layer.addBlocks([held()]);
    layer.onAdd(fakeMap() as never, gl);
    layer.render(gl, M);
    layer.render(gl, M);
    expect(calls).not.toContain("drawArraysInstanced");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
