/**
 * Three.js InstancedMesh tree layer for the avocado map.
 *
 * Fed a lean point payload (parallel ``names`` + flat ``coords`` arrays). Two
 * things keep tens of thousands of trees cheap:
 *
 *   • Culling — only trees inside the (padded) visible bounds are packed into
 *     the instance buffers each frame; everything off-screen costs nothing.
 *   • Per-tree level of detail — within the view, trees far from the centre
 *     draw as a single cheap cube and trees near the centre draw with full
 *     trunk + canopy detail. As you zoom in, the detailed ring covers more.
 *
 * The visible set is repacked on every camera move (coalesced to one pass per
 * frame), so culling/LOD tracks the camera smoothly instead of snapping when
 * movement settles. Mercator positions are precomputed once so each repack is
 * just comparisons + matrix writes.
 */
import maplibregl from "maplibre-gl";
import * as THREE from "three";

const UNSCOUTED_COLOR = "#7c8b6a";

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

    const c = map.getCenter();
    const centre = maplibregl.MercatorCoordinate.fromLngLat(c, 0);
    const westM = maplibregl.MercatorCoordinate.fromLngLat([b.getWest(), c.lat], 0);
    const eastM = maplibregl.MercatorCoordinate.fromLngLat([b.getEast(), c.lat], 0);
    // Full detail within ~25% of the visible width from the centre; cubes past.
    const lodR = Math.abs(eastM.x - westM.x) * 0.25;
    const lodRSq = lodR * lodR;

    const tmp = new THREE.Matrix4();
    const col = new THREE.Color();
    const fallback = new THREE.Color(UNSCOUTED_COLOR);
    const invMeter = 1 / this.meter;
    let ni = 0;
    let fi = 0;

    for (let i = 0; i < this.n; i++) {
      const lng = this.coords[i * 2];
      const lat = this.coords[i * 2 + 1];
      if (lng < west || lng > east || lat < south || lat > north) continue; // cull
      const dx = (this.mx[i] - this.anchor.x) * invMeter;
      const dz = (this.my[i] - this.anchor.y) * invMeter;
      tmp.makeTranslation(dx, 0, dz);
      const hex = this.treeColors.get(this.names[i]) || null;
      col.set(hex || (fallback as unknown as THREE.ColorRepresentation));

      const ddx = this.mx[i] - centre.x;
      const ddy = this.my[i] - centre.y;
      if (ddx * ddx + ddy * ddy > lodRSq) {
        this.cubeMesh.setMatrixAt(fi, tmp);
        this.cubeMesh.setColorAt(fi, col);
        fi++;
      } else {
        this.trunkMesh.setMatrixAt(ni, tmp);
        this.canopyMesh.setMatrixAt(ni, tmp);
        this.canopyMesh.setColorAt(ni, col);
        ni++;
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
