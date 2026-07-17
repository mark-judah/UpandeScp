/**
 * Three.js InstancedMesh tree layer for the avocado map.
 *
 * Fed a lean point payload (parallel ``names`` + flat ``coords`` arrays). Two
 * things keep tens of thousands of trees cheap:
 *
 *   • Culling — only trees inside the (padded) visible bounds are packed into
 *     the instance buffers each frame; everything off-screen costs nothing.
 *   • Zoom-responsive level of detail — each tree is sized in screen pixels at
 *     the current zoom (meters-per-pixel). Zoomed out (a tree is only a couple
 *     of pixels) every tree draws as one cheap cube, and the cube field is
 *     thinned by a stride so the draw count stays bounded; zoomed in, trees
 *     draw with full trunk + canopy detail. This is what makes a far-away
 *     orchard render as low-poly blocks and sharpen as you approach.
 *
 * The visible set is repacked on every camera move (coalesced to one pass per
 * frame), so culling/LOD tracks the camera smoothly instead of snapping when
 * movement settles. Mercator positions are precomputed once, and the repack
 * loop is O(n / stride) ≤ O(n) with buffers sized once — no worse in time or
 * space than a plain per-tree scan.
 */
import maplibregl from "maplibre-gl";
import * as THREE from "three";

const UNSCOUTED_COLOR = "#7c8b6a";

// LOD tuning. A tree's canopy apparent size (screen px) must reach DETAIL_PX
// before it draws with full trunk+canopy detail; below that it's a single cube.
// When trees shrink past ~1px, draw every ``stride``-th one (row-ordered, 5 m
// apart → merges adjacent same-row trees) targeting FAR_TARGET_PX spacing,
// capped at MAX_STRIDE so the cube field never inflates the draw count.
const DETAIL_PX = 8;
const FAR_TARGET_PX = 4;
const MAX_STRIDE = 8;
// Past the zoom gate, only trees within this ground radius (metres) of the view
// centre draw in full detail; everything else stays a cube even if on screen, so
// the high-res count is bounded no matter how much orchard is visible.
const DETAIL_RADIUS_M = 120;
// Web-Mercator earth circumference (m); MapLibre uses 512px tiles.
const EARTH_CIRCUMFERENCE_M = 40075016.686;
const TILE_SIZE = 512;

export interface TreePoints {
  names: string[];
  coords: number[]; // flat [lng0, lat0, lng1, lat1, …]
}

export class TreesLayer implements maplibregl.CustomLayerInterface {
  id = "trees";
  type = "custom" as const;
  renderingMode = "3d" as const;

  private names: string[];
  private coords: number[];
  private n: number;
  private mx!: Float64Array; // precomputed mercator x per tree
  private my!: Float64Array; // precomputed mercator y per tree
  private treeColors: Map<string, string>;
  private onReady?: () => void;
  private ready = false;
  private trunkH = 1.5;
  private canopyH = 2.5;
  private canopyR = 1.2;

  private map: maplibregl.Map | null = null;
  private camera!: THREE.Camera;
  private scene!: THREE.Scene;
  private renderer!: THREE.WebGLRenderer;
  private anchor!: maplibregl.MercatorCoordinate;
  private meter = 1;
  private trunkMesh!: THREE.InstancedMesh;
  private canopyMesh!: THREE.InstancedMesh;
  private cubeMesh!: THREE.InstancedMesh;
  private refreshQueued = false;

  constructor(
    points: TreePoints,
    treeColors: Map<string, string>,
    onReady?: () => void,
  ) {
    this.names = points.names || [];
    this.coords = points.coords || [];
    this.n = Math.min(this.names.length, Math.floor(this.coords.length / 2));
    this.treeColors = treeColors;
    this.onReady = onReady;
  }

  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext): void {
    this.map = map;
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(0.4, 1, 0.6);
    this.scene.add(sun);

    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl as unknown as WebGLRenderingContext,
      antialias: true,
    });
    this.renderer.autoClear = false;

    if (!this.n) {
      this.onReady?.();
      return;
    }

    // Precompute mercator positions once so repacks are trig-free.
    this.mx = new Float64Array(this.n);
    this.my = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const m = maplibregl.MercatorCoordinate.fromLngLat(
        [this.coords[i * 2], this.coords[i * 2 + 1]],
        0,
      );
      this.mx[i] = m.x;
      this.my[i] = m.y;
    }
    this.anchor = maplibregl.MercatorCoordinate.fromLngLat(
      [this.coords[0], this.coords[1]],
      0,
    );
    this.meter = this.anchor.meterInMercatorCoordinateUnits();

    // Trunk (detailed)
    const trunkGeo = new THREE.CylinderGeometry(0.12, 0.16, this.trunkH, 8);
    trunkGeo.translate(0, this.trunkH / 2, 0);
    this.trunkMesh = new THREE.InstancedMesh(
      trunkGeo,
      new THREE.MeshLambertMaterial({ color: 0x6b3f1e }),
      this.n,
    );

    // Canopy (detailed) — jittered icosahedron
    const canopyGeo = new THREE.IcosahedronGeometry(this.canopyR, 1);
    canopyGeo.scale(1, this.canopyH / (2 * this.canopyR), 1);
    const cpos = canopyGeo.attributes.position;
    const cTmp = new THREE.Vector3();
    const seen = new Map<string, [number, number, number]>();
    const jitter = this.canopyR * 0.2;
    for (let i = 0; i < cpos.count; i++) {
      cTmp.fromBufferAttribute(cpos, i);
      const key =
        cTmp.x.toFixed(4) + "_" + cTmp.y.toFixed(4) + "_" + cTmp.z.toFixed(4);
      let o = seen.get(key);
      if (!o) {
        const seed = Math.abs(cTmp.x * 12.9 + cTmp.y * 78.2 + cTmp.z * 37.7) + 1;
        const fn = (k: number) =>
          ((Math.sin(seed * k) * 43758.5453) % 1) * jitter;
        o = [fn(1.1), fn(2.7), fn(4.3)];
        seen.set(key, o);
      }
      cpos.setXYZ(i, cTmp.x + o[0], cTmp.y + o[1], cTmp.z + o[2]);
    }
    cpos.needsUpdate = true;
    canopyGeo.computeVertexNormals();
    canopyGeo.translate(0, this.trunkH + this.canopyH / 2, 0);
    this.canopyMesh = new THREE.InstancedMesh(
      canopyGeo,
      new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
      this.n,
    );

    // Cube (far LOD)
    const cubeH = this.trunkH + this.canopyH;
    const cubeGeo = new THREE.BoxGeometry(
      this.canopyR * 1.4,
      cubeH,
      this.canopyR * 1.4,
    );
    cubeGeo.translate(0, cubeH / 2, 0);
    this.cubeMesh = new THREE.InstancedMesh(
      cubeGeo,
      new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
      this.n,
    );

    for (const m of [this.trunkMesh, this.canopyMesh, this.cubeMesh]) {
      m.frustumCulled = false;
      m.count = 0;
    }
    this.scene.add(this.trunkMesh, this.canopyMesh, this.cubeMesh);

    this.rebuild();
    map.on("move", this.scheduleRebuild);
    map.on("moveend", this.scheduleRebuild);
  }

  private scheduleRebuild = (): void => {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      this.rebuild();
    });
  };

  /** Cull to the visible bounds, split survivors into near (detail) / far
   *  (cube) by distance from the view centre, and repack the buffers. */
  private rebuild(): void {
    const map = this.map;
    if (!map || !this.trunkMesh) return;

    const b = map.getBounds();
    // Generous padding so trees are packed before scrolling into view and the
    // one-frame lag between a move and this pass never shows an edge gap.
    const padX = (b.getEast() - b.getWest()) * 0.4;
    const padY = (b.getNorth() - b.getSouth()) * 0.4;
    const west = b.getWest() - padX;
    const east = b.getEast() + padX;
    const south = b.getSouth() - padY;
    const north = b.getNorth() + padY;

    // Zoom-responsive LOD in two stages. (1) Zoom gate: size a tree's canopy in
    // screen pixels at the current zoom — when it's only a few px, detail is
    // invisible, so every tree draws as a cheap cube (the field thinned by
    // ``stride``). (2) Once trees are big enough, only those within a FIXED
    // ground radius of the view centre draw with full trunk+canopy; trees past
    // it — even if on screen — stay cubes, so the high-res count is bounded no
    // matter how much orchard is visible.
    const c = map.getCenter();
    const centre = maplibregl.MercatorCoordinate.fromLngLat(c, 0);
    const mpp =
      (EARTH_CIRCUMFERENCE_M * Math.cos((c.lat * Math.PI) / 180)) /
      (TILE_SIZE * Math.pow(2, map.getZoom()));
    const treePx = (this.canopyR * 2) / mpp;
    const detailEligible = treePx >= DETAIL_PX;
    const radiusMerc = DETAIL_RADIUS_M * this.meter;
    const radiusMercSq = radiusMerc * radiusMerc;
    // Zoomed in, walk every tree (culling keeps the visible set small); zoomed
    // out, step by ``stride`` so the cube field never inflates the draw count.
    const stride = detailEligible
      ? 1
      : Math.min(
          MAX_STRIDE,
          Math.max(1, Math.round(FAR_TARGET_PX / Math.max(treePx, 1e-4))),
        );

    const tmp = new THREE.Matrix4();
    const col = new THREE.Color();
    const fallback = new THREE.Color(UNSCOUTED_COLOR);
    const invMeter = 1 / this.meter;
    let ni = 0;
    let fi = 0;

    for (let i = 0; i < this.n; i += stride) {
      const lng = this.coords[i * 2];
      const lat = this.coords[i * 2 + 1];
      if (lng < west || lng > east || lat < south || lat > north) continue; // cull
      let near = false;
      if (detailEligible) {
        const ddx = this.mx[i] - centre.x;
        const ddy = this.my[i] - centre.y;
        near = ddx * ddx + ddy * ddy <= radiusMercSq;
      }
      const dx = (this.mx[i] - this.anchor.x) * invMeter;
      const dz = (this.my[i] - this.anchor.y) * invMeter;
      tmp.makeTranslation(dx, 0, dz);
      const hex = this.treeColors.get(this.names[i]) || null;
      col.set(hex || (fallback as unknown as THREE.ColorRepresentation));

      if (near) {
        this.trunkMesh.setMatrixAt(ni, tmp);
        this.canopyMesh.setMatrixAt(ni, tmp);
        this.canopyMesh.setColorAt(ni, col);
        ni++;
      } else {
        this.cubeMesh.setMatrixAt(fi, tmp);
        this.cubeMesh.setColorAt(fi, col);
        fi++;
      }
    }

    this.trunkMesh.count = ni;
    this.canopyMesh.count = ni;
    this.cubeMesh.count = fi;
    this.trunkMesh.instanceMatrix.needsUpdate = true;
    this.canopyMesh.instanceMatrix.needsUpdate = true;
    this.cubeMesh.instanceMatrix.needsUpdate = true;
    if (this.canopyMesh.instanceColor)
      this.canopyMesh.instanceColor.needsUpdate = true;
    if (this.cubeMesh.instanceColor)
      this.cubeMesh.instanceColor.needsUpdate = true;
    map.triggerRepaint();

    if (!this.ready) {
      this.ready = true;
      this.onReady?.();
    }
  }

  updateColors(treeColors: Map<string, string>): void {
    this.treeColors = treeColors;
    this.rebuild();
  }

  render(_gl: WebGLRenderingContext, args: unknown): void {
    if (!this.canopyMesh || !this.anchor) return;
    let matrix: number[] | undefined;
    if (Array.isArray(args)) {
      matrix = args;
    } else if (args && typeof args === "object") {
      const a = args as Record<string, any>;
      matrix =
        a.defaultProjectionData?.mainMatrix ||
        a.defaultProjectionData?.matrix ||
        a.matrix;
    }
    if (!matrix || matrix.length !== 16) return;

    const meter = this.anchor.meterInMercatorCoordinateUnits();
    const rotX = new THREE.Matrix4().makeRotationAxis(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 2,
    );
    const world = new THREE.Matrix4()
      .makeTranslation(this.anchor.x, this.anchor.y, this.anchor.z)
      .scale(new THREE.Vector3(meter, -meter, meter))
      .multiply(rotX);
    this.camera.projectionMatrix = new THREE.Matrix4()
      .fromArray(matrix)
      .multiply(world);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    this.map?.triggerRepaint();
  }

  onRemove(): void {
    if (this.map) {
      this.map.off("move", this.scheduleRebuild);
      this.map.off("moveend", this.scheduleRebuild);
    }
    this.scene?.traverse((o: any) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}
