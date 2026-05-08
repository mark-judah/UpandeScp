/**
 * Three.js InstancedMesh tree layer for the avocado map — direct port of
 * the TreesLayer class in
 * upande_scp/www/avocado_scouts_map/index.html (lines 461–617).
 *
 * Why InstancedMesh: orchards have thousands of trees; sharing one trunk
 * and one canopy geometry across all of them keeps draw calls O(2) instead
 * of O(N). Per-tree colour goes through ``setColorAt`` so we can recolour
 * by scout coverage without rebuilding any meshes.
 */
import maplibregl from "maplibre-gl";
import * as THREE from "three";

const UNSCOUTED_COLOR = "#7c8b6a";

interface TreeFeature {
  geometry: { type: "Point"; coordinates: [number, number] };
  properties?: { tree_name?: string; [key: string]: unknown };
}

export class TreesLayer implements maplibregl.CustomLayerInterface {
  id = "trees";
  type = "custom" as const;
  renderingMode = "3d" as const;

  private features: TreeFeature[];
  private treeColors: Map<string, string>;
  private trunkH = 1.5;
  private canopyH = 2.5;
  private canopyR = 1.2;

  private map: maplibregl.Map | null = null;
  private camera!: THREE.Camera;
  private scene!: THREE.Scene;
  private renderer!: THREE.WebGLRenderer;
  private anchor!: maplibregl.MercatorCoordinate;
  private trunkMesh!: THREE.InstancedMesh;
  private canopyMesh!: THREE.InstancedMesh;

  constructor(features: TreeFeature[], treeColors: Map<string, string>) {
    this.features = features;
    this.treeColors = treeColors;
  }

  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext): void {
    this.map = map;
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(0.4, 1, 0.6);
    this.scene.add(sun);

    if (!this.features.length) {
      // Bail early but keep the layer registered; addTree* would push later.
      this.renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl as unknown as WebGLRenderingContext,
        antialias: true,
      });
      this.renderer.autoClear = false;
      return;
    }

    const [lng0, lat0] = this.features[0].geometry.coordinates;
    this.anchor = maplibregl.MercatorCoordinate.fromLngLat([lng0, lat0], 0);

    // ── Trunk: cylinder, base at y=0 ────────────────────────────────────
    const trunkGeo = new THREE.CylinderGeometry(0.12, 0.16, this.trunkH, 8);
    trunkGeo.translate(0, this.trunkH / 2, 0);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b3f1e });
    const trunkMesh = new THREE.InstancedMesh(
      trunkGeo,
      trunkMat,
      this.features.length,
    );

    // ── Canopy: low-poly icosahedron with deterministic vertex jitter ──
    const canopyGeo = new THREE.IcosahedronGeometry(this.canopyR, 1);
    canopyGeo.scale(1, this.canopyH / (2 * this.canopyR), 1);
    const cpos = canopyGeo.attributes.position;
    const cTmp = new THREE.Vector3();
    const cOffsets = new Map<string, [number, number, number]>();
    const jitter = this.canopyR * 0.2;
    for (let i = 0; i < cpos.count; i++) {
      cTmp.fromBufferAttribute(cpos, i);
      const key =
        cTmp.x.toFixed(4) + "_" + cTmp.y.toFixed(4) + "_" + cTmp.z.toFixed(4);
      let o = cOffsets.get(key);
      if (!o) {
        const seed = Math.abs(cTmp.x * 12.9 + cTmp.y * 78.2 + cTmp.z * 37.7) + 1;
        const f = (k: number) =>
          ((Math.sin(seed * k) * 43758.5453) % 1) * jitter;
        o = [f(1.1), f(2.7), f(4.3)];
        cOffsets.set(key, o);
      }
      cpos.setXYZ(i, cTmp.x + o[0], cTmp.y + o[1], cTmp.z + o[2]);
    }
    cpos.needsUpdate = true;
    canopyGeo.computeVertexNormals();
    canopyGeo.translate(0, this.trunkH + this.canopyH / 2, 0);

    const canopyMat = new THREE.MeshLambertMaterial({
      color: 0xffffff, // white — multiplied by the per-instance color
      flatShading: true,
      vertexColors: false,
    });
    const canopyMesh = new THREE.InstancedMesh(
      canopyGeo,
      canopyMat,
      this.features.length,
    );

    const meter = this.anchor.meterInMercatorCoordinateUnits();
    const tmp = new THREE.Matrix4();
    const tmpColor = new THREE.Color();
    const defaultColor = new THREE.Color(UNSCOUTED_COLOR);

    for (let i = 0; i < this.features.length; i++) {
      const [lng, lat] = this.features[i].geometry.coordinates;
      const m = maplibregl.MercatorCoordinate.fromLngLat([lng, lat], 0);
      const dx = (m.x - this.anchor.x) / meter;
      const dz = (m.y - this.anchor.y) / meter;
      tmp.makeTranslation(dx, 0, dz);
      trunkMesh.setMatrixAt(i, tmp);
      canopyMesh.setMatrixAt(i, tmp);

      const tn = this.features[i].properties?.tree_name;
      const hex = (tn && this.treeColors.get(tn)) || null;
      if (hex) {
        tmpColor.set(hex);
        canopyMesh.setColorAt(i, tmpColor);
      } else {
        canopyMesh.setColorAt(i, defaultColor);
      }
    }
    trunkMesh.instanceMatrix.needsUpdate = true;
    canopyMesh.instanceMatrix.needsUpdate = true;
    if (canopyMesh.instanceColor) canopyMesh.instanceColor.needsUpdate = true;

    this.trunkMesh = trunkMesh;
    this.canopyMesh = canopyMesh;
    this.scene.add(trunkMesh);
    this.scene.add(canopyMesh);

    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl as unknown as WebGLRenderingContext,
      antialias: true,
    });
    this.renderer.autoClear = false;
  }

  /** Recolour without rebuilding instance matrices. */
  updateColors(treeColors: Map<string, string>): void {
    if (!this.canopyMesh) return;
    this.treeColors = treeColors;
    const tmpColor = new THREE.Color();
    const defaultColor = new THREE.Color(UNSCOUTED_COLOR);
    for (let i = 0; i < this.features.length; i++) {
      const tn = this.features[i].properties?.tree_name;
      const hex = (tn && treeColors.get(tn)) || null;
      if (hex) {
        tmpColor.set(hex);
        this.canopyMesh.setColorAt(i, tmpColor);
      } else {
        this.canopyMesh.setColorAt(i, defaultColor);
      }
    }
    if (this.canopyMesh.instanceColor)
      this.canopyMesh.instanceColor.needsUpdate = true;
    this.map?.triggerRepaint();
  }

  render(gl: WebGLRenderingContext, args: unknown): void {
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
    this.scene?.traverse((o: any) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}
