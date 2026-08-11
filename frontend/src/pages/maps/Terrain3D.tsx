/**
 * 3D greenhouse terrain — observation counts as a continuous surface.
 *
 * A displaced plane mesh, not columns: the beds are closely packed, so the
 * surface should flow from peak to peak rather than stand as pillars with
 * vertical walls between neighbours. One mesh whose vertex heights are a single
 * typed array is also exactly what a tween wants to interpolate.
 *
 * Surface colour is a Blender-style weight-paint ramp (blue low → red high) on
 * a TRANSLUCENT mesh under an ORTHOGRAPHIC camera, because the question being
 * asked is comparative: which bed carries the most of a pest, and what the range
 * within that bed is. Orthographic keeps equal counts the same size wherever
 * they sit — perspective would make a near bed outrank a far one — and
 * translucency lets a low zone behind a peak still be read.
 *
 * Sighting straight down the bed axis or the zone axis turns the surface into a
 * profile, so the max and min inside a bed (or across a zone line) read off the
 * silhouette directly. Hence the axis view presets.
 *
 * Height means observation count and nothing else. Confidence — measured versus
 * interpolated — rides on OPACITY rather than height: estimated ground is more
 * transparent, so it recedes without a dip asserting an absence the data cannot
 * support. See terrain-field.ts for why unscouted ground is filled, not hollowed.
 *
 * Playback steps through complete weeks only; half-scouted weeks are skipped
 * but keep their slot in the timeline so a gap reads as missing data rather
 * than as a quiet week.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import gsap from "gsap";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScoutRow, type Scout } from "@/components/ScoutAvatar";
import {
  buildGroundLattice,
  buildLattice,
  latticeCellAt,
  peakAcross,
  timeline,
  weightPaintColor,
  weightPaintLegend,
  type Lattice,
} from "./terrain-field";

export interface TerrainWeekData {
  /** ISO-week label, e.g. "2026-W29" */
  date: string;
  zoneObs: Record<string, number>;
  complete?: boolean;
  /** Beds this week's sessions covered — the sample size, shown rather than
   *  used to withhold the week. */
  bedsScouted?: number;
  zonesScouted?: number;
  /** scouting sessions that made up the week */
  sessions?: number;
  scouts?: Scout[];
  coveragePct?: number | null;
  bedsTotal?: number;
  sprayEvents?: Array<{
    chemicals: string[];
    ingredients: string[];
    targets: string[];
    sprayType: string;
  }>;
}

export interface Terrain3DProps {
  weeks: TerrainWeekData[];
  /** Weekly weather for the farm, keyed by the same ISO week labels. Lets the
   *  view state what changed in the conditions alongside what changed in the
   *  terrain — the reason for stepping through weeks at all. */
  weather?: Array<{
    week: string;
    precipMm: number;
    precipDelta: number | null;
    tempDelta: number | null;
    humidityDelta: number | null;
  }>;
  /** zone name → projected position, from bed-projection */
  positions: Record<string, { x: number; y: number }>;
  className?: string;
  /** grid resolution along the longer axis */
  resolution?: number;
}

const GRID_RESOLUTION = 128;
/** Vertical exaggeration relative to the footprint's larger side. */
const HEIGHT_RATIO = 0.28;
/** Plane width in world units; everything else is derived from it. */
const PLANE_W = 10;
/** Thickness of the solid plinth the lattice rises from. Gives the model volume
 *  so it reads as a greenhouse block sitting on the ground rather than a sheet
 *  floating in space, and gives the surface a visible datum to measure from. */
const BASE_DEPTH = 0.55;
/** Surface opacity. Low enough to read a zone occluded behind a peak, high
 *  enough that the ramp colour still reads as a colour. */
const SURFACE_OPACITY = 0.74;

type ViewPreset = "iso" | "top" | "beds" | "zones";

/** How the surface is laid out in plan.
 *
 *  `order` indexes by bed number, giving numbered axes and one continuous run
 *  of beds — right for comparing bed 10 against bed 140 by number.
 *
 *  `ground` uses the projected zone geometry, matching the 2D bed plot. Bed
 *  numbering here is U-shaped, so bed 10 can physically sit beside bed 140;
 *  only this mode shows where a hotspot actually IS on the ground. Neither is a
 *  substitute for the other, so both are offered. */
type LayoutMode = "order" | "ground";

const VIEW_LABEL: Record<ViewPreset, string> = {
  iso: "Iso",
  top: "Top",
  beds: "Along beds",
  zones: "Along zones",
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
  );
}

/** Sample a field at a plane vertex (grid coords map 1:1 onto the plane). */
function sampleField(f: Lattice, col: number, row: number): number {
  if (!f.cols || !f.rows) return 0;
  const c = Math.min(f.cols - 1, Math.max(0, col));
  const r = Math.min(f.rows - 1, Math.max(0, row));
  return f.heights[r * f.cols + c];
}

function sampleConfidence(f: Lattice, col: number, row: number): number {
  if (!f.cols || !f.rows) return 0;
  const c = Math.min(f.cols - 1, Math.max(0, col));
  const r = Math.min(f.rows - 1, Math.max(0, row));
  return f.confidence[r * f.cols + c];
}

export function Terrain3D({
  weeks,
  weather,
  positions,
  className,
  resolution = GRID_RESOLUTION,
}: Terrain3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<ViewPreset>("iso");
  const [layout, setLayout] = useState<LayoutMode>("order");
  const [hover, setHover] = useState<{
    x: number; y: number; bed: number; zone: number; value: number; measured: boolean;
  } | null>(null);
  // Refs so the pointer handler (bound once at scene setup) always reads the
  // current frame's lattice and the live setter.
  const onHoverRef = useRef(setHover);
  onHoverRef.current = setHover;
  const fieldRef = useRef<Lattice | null>(null);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const viewRef = useRef<ViewPreset>("iso");
  viewRef.current = view;

  // Every week with data is steppable, partial ones included: the interpolation
  // already flows the surface smoothly across beds a session skipped, so there
  // is no trough to hide. Sample size is surfaced instead (see the caption).
  const marks = useMemo(() => timeline(weeks), [weeks]);
  const playable = useMemo(() => marks.filter((m) => m.playable), [marks]);

  // Bed × zone index space, not projected geometry: that is what lets the axes
  // carry real bed numbers and a hovered cell name its bed. `positions` supplies
  // the full zone roster so the axes span every bed in the house, not only the
  // ones scouted this week.
  const fields = useMemo<Lattice[]>(() => {
    const roster = Object.keys(positions);
    return playable.map((m) => {
      const names = roster.length ? roster : Object.keys(m.week.zoneObs);
      const entries: Array<{ name: string; value: number }> = [];
      for (const name of names) {
        const v = m.week.zoneObs[name];
        if (v === undefined) continue; // unscouted — interpolated, not zeroed
        entries.push({ name, value: v });
      }
      if (layout === "order") return buildLattice(entries, { smoothPasses: 2 });
      // Ground shape: project through the real zone positions, then carry the
      // bed/zone labels along so the tooltip still names the bed.
      return buildGroundLattice(entries, positions, { resolution });
    });
  }, [playable, positions, layout, resolution]);

  const peak = useMemo(() => peakAcross(fields) || 1, [fields]);

  // Keep the frame in range when the week set changes under us.
  useEffect(() => {
    setFrame((f) => (f >= fields.length ? Math.max(0, fields.length - 1) : f));
  }, [fields.length]);

  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.OrthographicCamera;
    controls: OrbitControls;
    mesh: THREE.Mesh;
    geo: THREE.PlaneGeometry;
    dispose: () => void;
    applyView: (v: ViewPreset) => void;
  } | null>(null);

  // --- scene setup -------------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !fields.length) return;

    const base = fields[0];
    const cols = Math.max(2, base.cols);
    const rows = Math.max(2, base.rows);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setClearColor(0xffffff, 1);
    renderer.localClippingEnabled = false;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);

    const spanX = base.maxX - base.minX || 1;
    const spanY = base.maxY - base.minY || 1;
    const planeW = PLANE_W;
    const planeH = PLANE_W * (spanY / spanX);
    const maxSide = Math.max(planeW, planeH);

    // Orthographic, not perspective: a bed's peak must not look taller merely
    // because it is nearer the camera. Equal counts read equal anywhere in the
    // house, which is what makes bed-to-bed comparison valid.
    // 0.85 framed the model with far too much empty margin. 0.58 fills the
    // viewport; OrbitControls zoom still adjusts from there.
    const halfH = maxSide * 0.58;
    const camera = new THREE.OrthographicCamera(-halfH, halfH, halfH, -halfH, -500, 1000);
    camera.zoom = 1;

    const geo = new THREE.PlaneGeometry(planeW, planeH, cols - 1, rows - 1);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.0,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: SURFACE_OPACITY,
      // Without this the surface hides its own far side, which defeats the
      // point: the low zone behind a peak has to stay readable.
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    scene.add(mesh);

    // Wireframe of the same surface — under an orthographic axis view this is
    // what turns a translucent blob into a readable profile, because each bed
    // and zone line is individually traceable.
    const wire = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0x2b2b2b,
        wireframe: true,
        transparent: true,
        opacity: 0.06,
        depthWrite: false,
      }),
    );
    wire.renderOrder = 3;
    scene.add(wire);

    // --- the plinth: solid volume from the ground up to the lattice datum ---
    const plinthMat = new THREE.MeshStandardMaterial({
      color: 0xe9e6e0,
      roughness: 0.95,
      metalness: 0,
      transparent: true,
      opacity: 0.9,
    });
    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(planeW, BASE_DEPTH, planeH),
      plinthMat,
    );
    // Top face at y = 0 so the height field measures from the plinth surface.
    plinth.position.y = -BASE_DEPTH / 2;
    plinth.renderOrder = 0;
    scene.add(plinth);

    // Crisp edge on the plinth so the block reads as a solid object in ortho,
    // where there is no perspective convergence to imply depth.
    const plinthEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(planeW, BASE_DEPTH, planeH)),
      new THREE.LineBasicMaterial({ color: 0x8d8880, transparent: true, opacity: 0.85 }),
    );
    plinthEdges.position.copy(plinth.position);
    scene.add(plinthEdges);

    // Ground shadow-plate, slightly larger, to seat the block on a surface.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(planeW * 1.35, planeH * 1.35),
      new THREE.MeshBasicMaterial({
        color: 0xf1efea,
        transparent: true,
        opacity: 0.9,
      }),
    );
    ground.rotateX(-Math.PI / 2);
    ground.position.y = -BASE_DEPTH - 0.012;
    ground.renderOrder = -1;
    scene.add(ground);

    // Lighting tuned for a white ground: soft fill plus two directionals so the
    // ramp colours stay true instead of being washed out or blown.
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 0.55);
    key.position.set(6, 12, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.25);
    rim.position.set(-7, 6, -5);
    scene.add(rim);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2.02; // never drop under the plinth

    // --- axis tick labels ------------------------------------------------
    // Canvas-texture sprites rather than an HTML overlay: they live in the
    // scene, so they track the camera without per-frame projection maths.
    const makeLabel = (text: string) => {
      const cv = document.createElement("canvas");
      cv.width = 128;
      cv.height = 64;
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = "#3a3733";
      ctx.font = "600 40px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, cv.width / 2, cv.height / 2);
      const tex = new THREE.CanvasTexture(cv);
      tex.minFilter = THREE.LinearFilter;
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
      );
      // Base scale; the render loop rescales by camera.zoom so the label holds
      // a constant SCREEN size — an orthographic zoom otherwise magnifies the
      // sprite along with the model and the numbers swamp the view.
      sp.userData.baseScale = [maxSide * 0.1, maxSide * 0.05];
      sp.scale.set(maxSide * 0.1, maxSide * 0.05, 1);
      return sp;
    };
    const labelSprites: THREE.Sprite[] = [];

    const axisGroup = new THREE.Group();
    scene.add(axisGroup);
    // Ground layout has no bed-aligned axis, so numbering it would be a lie.
    axisGroup.visible = base.identity === "axis";

    // Beds run along Z (rows), zones along X (cols). Label every Nth tick so a
    // 90-bed house stays readable rather than a smear of numbers.
    const bedStep = Math.max(1, Math.ceil(base.rows / 12));
    const zoneStep = Math.max(1, Math.ceil(base.cols / 12));
    for (let r = 0; r < base.rows; r += bedStep) {
      const sp = makeLabel(String(base.bedNumbers[r] ?? r + 1));
      const z = -planeH / 2 + (r / Math.max(1, base.rows - 1)) * planeH;
      sp.position.set(-planeW / 2 - maxSide * 0.075, 0.02, z);
      labelSprites.push(sp);
      axisGroup.add(sp);
    }
    for (let c = 0; c < base.cols; c += zoneStep) {
      const sp = makeLabel(String(base.zoneNumbers[c] ?? c + 1));
      const x = -planeW / 2 + (c / Math.max(1, base.cols - 1)) * planeW;
      sp.position.set(x, 0.02, planeH / 2 + maxSide * 0.06);
      labelSprites.push(sp);
      axisGroup.add(sp);
    }

    // --- bed-flow path: the U the numbering actually traces ---------------
    // Bed numbers run in a U around the house, so consecutive numbers are not
    // spatially consecutive. Drawing bed 1 → 2 → … → N through their real
    // positions makes that route visible, which is the whole reason the ground
    // layout exists. Only meaningful here — in bed-order layout the "route"
    // would just be a straight line by construction.
    const flowGroup = new THREE.Group();
    flowGroup.visible = base.identity === "cell";
    scene.add(flowGroup);
    if (base.identity === "cell") {
      const centroids = new Map<number, { x: number; y: number; n: number }>();
      for (const [name, pos] of Object.entries(positionsRef.current)) {
        const m = /Bed\s+(\d+)/i.exec(name);
        if (!m) continue;
        const bed = Number(m[1]);
        const c = centroids.get(bed) || { x: 0, y: 0, n: 0 };
        c.x += pos.x;
        c.y += pos.y;
        c.n += 1;
        centroids.set(bed, c);
      }
      const ordered = [...centroids.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([bed, c]) => ({ bed, x: c.x / c.n, y: c.y / c.n }));
      if (ordered.length > 1) {
        const sx = base.maxX - base.minX || 1;
        const sy = base.maxY - base.minY || 1;
        const pts = ordered.map(
          (o) =>
            new THREE.Vector3(
              -planeW / 2 + ((o.x - base.minX) / sx) * planeW,
              0.015,
              -planeH / 2 + ((o.y - base.minY) / sy) * planeH,
            ),
        );
        flowGroup.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(pts),
            new THREE.LineBasicMaterial({
              color: 0x7c3aed,
              transparent: true,
              opacity: 0.5,
            }),
          ),
        );
        // Mark the start so the direction of travel is unambiguous.
        const startDot = new THREE.Mesh(
          new THREE.SphereGeometry(maxSide * 0.012, 12, 12),
          new THREE.MeshBasicMaterial({ color: 0x7c3aed }),
        );
        startDot.position.copy(pts[0]);
        flowGroup.add(startDot);
      }
    }

    // --- hover: raycast to a lattice cell --------------------------------
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const onMove = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObject(mesh, false)[0];
      const f = fieldRef.current;
      if (!hit || !f || !f.cols) {
        onHoverRef.current(null);
        return;
      }
      const local = mesh.worldToLocal(hit.point.clone());
      const fx = (local.x + planeW / 2) / planeW;
      const fz = (local.z + planeH / 2) / planeH;
      const cell = latticeCellAt(
        f,
        Math.round(fx * (f.cols - 1)),
        Math.round(fz * (f.rows - 1)),
      );
      onHoverRef.current(
        cell ? { x: ev.clientX - rect.left, y: ev.clientY - rect.top, ...cell } : null,
      );
    };
    const onLeave = () => onHoverRef.current(null);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerleave", onLeave);

    let raf = 0;
    let lastZoom = -1;
    const loop = () => {
      controls.update();
      // Counter-scale the tick labels so their on-screen size is zoom-invariant.
      if (camera.zoom !== lastZoom) {
        lastZoom = camera.zoom;
        const k = 1 / Math.max(0.0001, camera.zoom);
        for (const sp of labelSprites) {
          const [bx, by] = sp.userData.baseScale as [number, number];
          sp.scale.set(bx * k, by * k, 1);
        }
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    // Orthographic cameras have no aspect field — the frustum itself has to be
    // reshaped, or the model stretches with the container.
    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      const a = w / h;
      camera.left = -halfH * a;
      camera.right = halfH * a;
      camera.top = halfH;
      camera.bottom = -halfH;
      camera.updateProjectionMatrix();
    };
    onResize();
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    const dispose = () => {
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerleave", onLeave);
      ro.disconnect();
      controls.dispose();
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
    };

    // Axis presets. Sighting down an axis in orthographic collapses the surface
    // into a profile, which is how the max and min inside a bed become directly
    // comparable rather than a matter of judging a 3D shape.
    const applyView = (v: ViewPreset) => {
      const d = maxSide * 1.6;
      // Axis views LOCK the camera square-on so the requested axis runs
      // left-to-right across the screen and its numbers read 1..N in order:
      //   beds  → look down +X, beds (Z) span the screen
      //   zones → look down +Z, zones (X) span the screen
      // A low elevation keeps it a near-profile, which is what makes the
      // highest and lowest cell along that axis directly comparable.
      controls.enableRotate = v === "iso";
      if (v === "top") {
        camera.position.set(0, d, 0.0001);
        camera.up.set(0, 0, -1);
      } else if (v === "beds") {
        camera.position.set(d, maxSide * 0.22, 0);
        camera.up.set(0, 1, 0);
      } else if (v === "zones") {
        camera.position.set(0, maxSide * 0.22, d);
        camera.up.set(0, 1, 0);
      } else {
        camera.position.set(d * 0.62, d * 0.66, d * 0.62);
        camera.up.set(0, 1, 0);
      }
      camera.lookAt(0, 0, 0);
      controls.target.set(0, 0, 0);
      controls.update();
    };
    applyView(viewRef.current);

    sceneRef.current = {
      renderer, scene, camera, controls, mesh, geo, dispose, applyView,
    };
    return dispose;
    // Rebuild only when the grid shape changes; frame changes are tweened.
  }, [fields.length ? `${fields[0].cols}x${fields[0].rows}` : "empty"]);

  // --- frame application (tweened) ---------------------------------------
  useEffect(() => {
    const s = sceneRef.current;
    const field = fields[frame];
    if (!s || !field) return;

    fieldRef.current = field;
    const geo = s.geo;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const vertexCount = pos.count;
    const cols = field.cols;

    if (!geo.attributes.color) {
      geo.setAttribute(
        "color",
        new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3),
      );
    }
    const colAttr = geo.attributes.color as THREE.BufferAttribute;

    const spanX = field.maxX - field.minX || 1;
    const planeH = 10 * ((field.maxY - field.minY || 1) / spanX);
    const heightScale = (Math.max(10, planeH) * HEIGHT_RATIO) / peak;

    const target = new Float32Array(vertexCount);
    const targetConf = new Float32Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) {
      const c = v % cols;
      const r = Math.floor(v / cols);
      target[v] = sampleField(field, c, r) * heightScale;
      targetConf[v] = sampleConfidence(field, c, r);
    }

    const from = new Float32Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) from[v] = pos.getY(v);

    const apply = (t: number) => {
      for (let v = 0; v < vertexCount; v++) {
        const y = from[v] + (target[v] - from[v]) * t;
        pos.setY(v, y);

        // Weight paint: the ramp is driven by the NORMALISED COUNT, not by the
        // rendered height, so colour stays meaningful when vertical
        // exaggeration changes.
        const norm = peak > 0 ? (target[v] / heightScale) / peak : 0;
        const c = weightPaintColor(norm);

        // Confidence rides on lightness toward the white ground, not on height:
        // estimated ground washes out and recedes, while height keeps meaning
        // count and only count.
        const conf = targetConf[v];
        const wash = 0.35 + 0.65 * conf;
        colAttr.setXYZ(
          v,
          c.r * wash + (1 - wash),
          c.g * wash + (1 - wash),
          c.b * wash + (1 - wash),
        );
      }
      pos.needsUpdate = true;
      colAttr.needsUpdate = true;
      geo.computeVertexNormals();
    };

    if (prefersReducedMotion()) {
      apply(1);
      return;
    }
    const state = { t: 0 };
    const tween = gsap.to(state, {
      t: 1,
      duration: 0.9,
      ease: "power2.inOut",
      onUpdate: () => apply(state.t),
    });
    return () => {
      tween.kill();
    };
  }, [frame, fields, peak]);

  useEffect(() => {
    sceneRef.current?.applyView(view);
  }, [view]);

  // --- playback ----------------------------------------------------------
  useEffect(() => {
    if (!playing || fields.length < 2) return;
    const id = setInterval(() => {
      setFrame((f) => {
        if (f + 1 >= fields.length) {
          setPlaying(false);
          return f;
        }
        return f + 1;
      });
    }, 1200);
    return () => clearInterval(id);
  }, [playing, fields.length]);

  const current = playable[frame]?.week;
  const canPlay = fields.length >= 2 && !prefersReducedMotion();

  if (!fields.length) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-md border p-6 text-center text-xs text-muted-foreground",
          className,
        )}
      >
        No scouting entries for this greenhouse and observation in the selected
        range — widen the dates to reach a week that was scouted.
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="relative">
        <div
          ref={mountRef}
          className="relative min-h-[62vh] w-full flex-1 overflow-hidden rounded-md border bg-white"
        />
        {hover && (
          <div
            className="pointer-events-none absolute z-10 rounded-md border bg-background/95 px-2 py-1 text-[0.7rem] shadow-md"
            style={{
              left: Math.max(4, hover.x + 12),
              top: Math.max(4, hover.y + 12),
            }}
          >
            <div className="font-medium tabular-nums">
              Bed {hover.bed} · Zone {hover.zone}
            </div>
            <div className="font-mono tabular-nums text-muted-foreground">
              {hover.value.toFixed(1)} obs
              {hover.measured ? "" : " (estimated)"}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 text-[0.7rem]">
        {canPlay && (
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            className="inline-flex h-6 items-center gap-1 rounded-md border px-2 hover:bg-muted"
          >
            {playing ? (
              <Pause className="h-3 w-3" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            {playing ? "Pause" : "Play"}
          </button>
        )}
        <span className="font-medium tabular-nums">
          {current?.date?.replace("-W", " · Week ") ?? ""}
        </span>

        {/* Axis presets. "Along beds"/"Along zones" sight straight down an axis,
            which in orthographic collapses the surface to a profile — that is
            what makes the highest and lowest zone within a bed directly
            comparable instead of a 3D judgement call. */}
        {/* Layout: bed order (numbered, comparable) vs ground shape (matches
            the 2D plot). Bed numbering is U-shaped, so bed 10 can sit beside
            bed 140 physically — only "Ground" shows where a hotspot really is. */}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setLayout((l) => (l === "order" ? "ground" : "order"))}
            title={
              layout === "order"
                ? "Beds laid out in numeric order, axes labelled 1..N. Switch to the real ground shape."
                : "Real ground shape, matching the 2D plot. Switch to numeric bed order."
            }
            className="h-6 rounded-md border px-1.5 text-[0.65rem] hover:bg-muted"
          >
            {layout === "order" ? "Bed order" : "Ground shape"}
          </button>
          <span className="mx-0.5 h-4 w-px bg-[var(--sd-line)]" />
          {(Object.keys(VIEW_LABEL) as ViewPreset[]).map((v) => (
            <button
              key={v}
              type="button"
              disabled={layout === "ground" && (v === "beds" || v === "zones")}
              onClick={() => setView(v)}
              className={cn(
                "h-6 rounded-md border px-1.5 text-[0.65rem] transition-colors",
                view === v
                  ? "border-foreground bg-foreground text-background"
                  : "hover:bg-muted",
              )}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
        {(() => {
          const w = weather?.find((x) => x.week === current?.date);
          if (!w) return null;
          const parts: string[] = [];
          if (w.precipDelta !== null && Math.abs(w.precipDelta) >= 1)
            parts.push(`rain ${w.precipDelta > 0 ? "+" : "−"}${Math.abs(w.precipDelta)}mm`);
          if (w.humidityDelta !== null && Math.abs(w.humidityDelta) >= 3)
            parts.push(`humidity ${w.humidityDelta > 0 ? "+" : "−"}${Math.abs(w.humidityDelta)}%`);
          if (w.tempDelta !== null && Math.abs(w.tempDelta) >= 1)
            parts.push(`temp ${w.tempDelta > 0 ? "+" : "−"}${Math.abs(w.tempDelta)}°`);
          if (!parts.length) return null;
          // Only a material change earns a badge — flagging every ±0.1mm would
          // make the signal worthless.
          const wetter = (w.precipDelta ?? 0) > 0;
          return (
            <span
              className={cn(
                "rounded-full px-1.5 py-px text-[0.6rem] tabular-nums ring-1",
                wetter
                  ? "text-[var(--sd-data-cyan)] ring-[var(--sd-data-cyan)]"
                  : "text-muted-foreground ring-[var(--sd-line)]",
              )}
              title={`Weather change on the previous week — ${parts.join(", ")}. Week total ${w.precipMm}mm rain.`}
            >
              {parts.join(" · ")}
            </span>
          );
        })()}

        {current?.bedsScouted ? (
          <span
            className={cn(
              "rounded-full px-1.5 py-px text-[0.6rem] tabular-nums",
              current.complete === false
                ? "text-[var(--sd-data-amber)] ring-1 ring-[var(--sd-data-amber)]"
                : "text-muted-foreground ring-1 ring-[var(--sd-line)]",
            )}
            title={
              `Sample: ${current.bedsScouted} bed${current.bedsScouted === 1 ? "" : "s"}` +
              `, ${current.zonesScouted ?? 0} zone${current.zonesScouted === 1 ? "" : "s"}` +
              ` across ${current.sessions ?? 0} session${current.sessions === 1 ? "" : "s"}.` +
              (current.complete === false
                ? " One bed parity only — the surface between unvisited beds is interpolated."
                : " Both bed halves covered.")
            }
          >
            {current.bedsScouted} beds · {current.zonesScouted ?? 0} zones
          </span>
        ) : null}

        {!!current?.sprayEvents?.length && (
          <span
            className="rounded-full px-1.5 py-px text-[0.6rem] text-[var(--sd-data-violet,#7c3aed)] ring-1 ring-[var(--sd-data-violet,#7c3aed)]"
            title={current.sprayEvents
              .map(
                (e) =>
                  `${e.ingredients.join(" + ") || "AI not recorded"} (${e.chemicals.join(" + ")})` +
                  (e.targets.length ? ` → ${e.targets.join(", ")}` : ""),
              )
              .join("\n")}
          >
            sprayed
          </span>
        )}
      </div>

      {current?.scouts?.length || current?.coveragePct != null ? (
        <ScoutRow
          scouts={current?.scouts}
          coveragePct={current?.coveragePct}
          bedsScouted={current?.bedsScouted}
          bedsTotal={current?.bedsTotal}
        />
      ) : null}

      {/* Timeline: skipped weeks keep their slot, so a gap reads as missing
          data rather than as a quiet week. */}
      <div className="flex flex-wrap items-center gap-1">
        {marks.map((m) => (
          <button
            key={m.week.date}
            type="button"
            onClick={() => m.frame !== null && setFrame(m.frame)}
            title={
              `${m.week.date} — ${m.week.bedsScouted ?? 0} beds scouted` +
              (m.week.complete === false ? " (one bed parity only)" : "")
            }
            className={cn(
              "h-1.5 w-6 rounded-full transition-colors",
              m.frame === frame
                ? "bg-foreground"
                : m.week.complete === false
                ? // partial weeks stay selectable, just visibly thinner-sampled
                  "bg-[var(--sd-data-amber)]/50 hover:bg-[var(--sd-data-amber)]"
                : "bg-muted-foreground/60 hover:bg-foreground/70",
            )}
          />
        ))}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[0.65rem] tabular-nums text-muted-foreground">0</span>
        <div className="flex h-2 flex-1 overflow-hidden rounded-full">
          {weightPaintLegend(28).map((st) => (
            <span
              key={st.t}
              className="flex-1"
              style={{ background: st.css }}
            />
          ))}
        </div>
        <span className="text-[0.65rem] tabular-nums text-muted-foreground">
          {peak.toFixed(1)} / {"zone"}
        </span>
      </div>

      <p className="text-[0.65rem] leading-snug text-muted-foreground">
        Colour and height both encode observations per zone, on one scale across
        every week shown — blue lowest, red highest. Washed-out, pale areas are{" "}
        <strong>estimated</strong> from nearby scouted zones rather than measured;
        unscouted beds are interpolated, never drawn as dips. The surface is
        translucent so a low zone behind a peak stays readable. Amber ticks are
        weeks scouted on one bed parity only — still shown, with their sample
        size, since the surface is interpolated smoothly across the beds a
        session skipped.
      </p>
    </div>
  );
}
