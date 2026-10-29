/**
 * Three.js layer for the Application Plan's 3D view: one icosphere per scouting value
 * (sphere-data.spherePoints), instanced like TreesLayer, in the observation's colour, radius by
 * value (sphereRadius), floating just above the ground, breathing gently (spherePulse) unless the
 * user prefers reduced motion — then it is drawn once per camera move and stands still.
 */
import maplibregl from "maplibre-gl";
import * as THREE from "three";
import { prefersReducedMotion, pulsePhase } from "@/lib/trap-pulse";
import { sphereRadius, spherePulse, type SpherePoint } from "./sphere-data";

export class SpheresLayer implements maplibregl.CustomLayerInterface {
  id = "scouting-spheres";
  type = "custom" as const;
  renderingMode = "3d" as const;

  private points: SpherePoint[];
  private color: string;
  private map: maplibregl.Map | null = null;
  private camera!: THREE.Camera;
  private scene!: THREE.Scene;
  private renderer!: THREE.WebGLRenderer;
  private mesh: THREE.InstancedMesh | null = null;
  private anchor: maplibregl.MercatorCoordinate | null = null;
  private offsets: Float64Array = new Float64Array(0); // dx, dz (metres) per sphere
  private radii: Float32Array = new Float32Array(0);
  private phases: Float32Array = new Float32Array(0);
  private reduced = prefersReducedMotion();

  constructor(points: SpherePoint[], color: string) {
    this.points = points;
    this.color = color;
  }

  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext): void {
    this.map = map;
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(0.4, 1, 0.6);
    this.scene.add(sun);
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl as unknown as WebGLRenderingContext, antialias: true });
    this.renderer.autoClear = false;
    this.build();
  }

  /** New points or colour (another observation, another window): rebuild the instances. */
  update(points: SpherePoint[], color: string): void {
    this.points = points;
    this.color = color;
    if (this.map) this.build();
  }

  private build(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }
    const n = this.points.length;
    if (!n) {
      this.map?.triggerRepaint();
      return;
    }
    this.anchor = maplibregl.MercatorCoordinate.fromLngLat([this.points[0].lng, this.points[0].lat], 0);
    const meter = this.anchor.meterInMercatorCoordinateUnits();
    this.offsets = new Float64Array(n * 2);
    this.radii = new Float32Array(n);
    this.phases = new Float32Array(n);
    this.points.forEach((p, i) => {
      const m = maplibregl.MercatorCoordinate.fromLngLat([p.lng, p.lat], 0);
      this.offsets[i * 2] = (m.x - this.anchor!.x) / meter;
      this.offsets[i * 2 + 1] = (m.y - this.anchor!.y) / meter;
      this.radii[i] = sphereRadius(p.value);
      this.phases[i] = pulsePhase(p.key);
    });
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(this.color), transparent: true, opacity: 0.88 });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.place(performance.now());
    this.scene.add(this.mesh);
    this.map?.triggerRepaint();
  }

  private place(ms: number): void {
    if (!this.mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let i = 0; i < this.radii.length; i++) {
      const r = this.radii[i] * spherePulse(ms, this.phases[i], this.reduced);
      // Float the sphere so it sits on the ground at rest, centred over its unit.
      pos.set(this.offsets[i * 2], this.radii[i] + 0.2, this.offsets[i * 2 + 1]);
      scale.set(r, r, r);
      m.compose(pos, q, scale);
      this.mesh.setMatrixAt(i, m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  render(_gl: WebGLRenderingContext, args: unknown): void {
    if (!this.mesh || !this.anchor) return;
    let matrix: number[] | undefined;
    if (Array.isArray(args)) matrix = args;
    else if (args && typeof args === "object") {
      const a = args as Record<string, any>;
      matrix = a.defaultProjectionData?.mainMatrix || a.defaultProjectionData?.matrix || a.matrix;
    }
    if (!matrix || matrix.length !== 16) return;
    if (!this.reduced) this.place(performance.now());
    const meter = this.anchor.meterInMercatorCoordinateUnits();
    const rotX = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const world = new THREE.Matrix4()
      .makeTranslation(this.anchor.x, this.anchor.y, this.anchor.z)
      .scale(new THREE.Vector3(meter, -meter, meter))
      .multiply(rotX);
    this.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(world);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    // Only a breathing field needs the next frame; a still one redraws when the camera moves.
    if (!this.reduced) this.map?.triggerRepaint();
  }

  onRemove(): void {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
    this.mesh = null;
    this.map = null;
  }
}
