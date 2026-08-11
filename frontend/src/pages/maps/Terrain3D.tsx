/**
 * 3D greenhouse terrain — observation counts as a continuous surface.
 *
 * A displaced plane mesh, not columns: the beds are closely packed, so the
 * surface should flow from peak to peak rather than stand as pillars with
 * vertical walls between neighbours. One mesh whose vertex heights are a single
 * typed array is also exactly what a tween wants to interpolate.
 *
 * Height means observation count and nothing else. Confidence — measured versus
 * interpolated — is carried in COLOUR (interpolated ground desaturates toward
 * grey), never in shape, because a dip would assert an absence the data cannot
 * support. See terrain-field.ts for why unscouted ground is filled rather than
 * hollowed.
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
import {
  buildHeightField,
  peakAcross,
  timeline,
  type HeightField,
  type ZonePoint,
} from "./terrain-field";

export interface TerrainWeekData {
  /** ISO-week label, e.g. "2026-W29" */
  date: string;
  zoneObs: Record<string, number>;
  complete?: boolean;
  sprayEvents?: Array<{
    chemicals: string[];
    ingredients: string[];
    targets: string[];
    sprayType: string;
  }>;
}

export interface Terrain3DProps {
  weeks: TerrainWeekData[];
  /** zone name → projected position, from bed-projection */
  positions: Record<string, { x: number; y: number }>;
  /** base colour for the observation (severity tinting rides on top) */
  color: string;
  className?: string;
  /** grid resolution along the longer axis */
  resolution?: number;
}

const GRID_RESOLUTION = 128;
/** Vertical exaggeration relative to the footprint's larger side. */
const HEIGHT_RATIO = 0.28;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
  );
}

/** Sample a field at a plane vertex (grid coords map 1:1 onto the plane). */
function sampleField(f: HeightField, col: number, row: number): number {
  if (!f.cols || !f.rows) return 0;
  const c = Math.min(f.cols - 1, Math.max(0, col));
  const r = Math.min(f.rows - 1, Math.max(0, row));
  return f.heights[r * f.cols + c];
}

function sampleConfidence(f: HeightField, col: number, row: number): number {
  if (!f.cols || !f.rows) return 0;
  const c = Math.min(f.cols - 1, Math.max(0, col));
  const r = Math.min(f.rows - 1, Math.max(0, row));
  return f.confidence[r * f.cols + c];
}

export function Terrain3D({
  weeks,
  positions,
  color,
  className,
  resolution = GRID_RESOLUTION,
}: Terrain3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Only complete weeks are steppable — interpolation stops a half-scouted week
  // collapsing, but it cannot manufacture information, and stepping through one
  // beside full weeks would give a guess the authority of a measurement.
  const marks = useMemo(() => timeline(weeks), [weeks]);
  const playable = useMemo(() => marks.filter((m) => m.playable), [marks]);

  const fields = useMemo(() => {
    return playable.map((m) => {
      const zones: ZonePoint[] = [];
      for (const [zone, pos] of Object.entries(positions)) {
        const v = m.week.zoneObs[zone];
        if (v === undefined) continue; // unscouted — filled, not zeroed
        zones.push({ x: pos.x, y: pos.y, value: v });
      }
      return buildHeightField(zones, { resolution });
    });
  }, [playable, positions, resolution]);

  const peak = useMemo(() => peakAcross(fields) || 1, [fields]);

  // Keep the frame in range when the week set changes under us.
  useEffect(() => {
    setFrame((f) => (f >= fields.length ? Math.max(0, fields.length - 1) : f));
  }, [fields.length]);

  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    mesh: THREE.Mesh;
    geo: THREE.PlaneGeometry;
    dispose: () => void;
  } | null>(null);

  // --- scene setup -------------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !fields.length) return;

    const base = fields[0];
    const cols = Math.max(2, base.cols);
    const rows = Math.max(2, base.rows);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      45,
      mount.clientWidth / Math.max(1, mount.clientHeight),
      0.1,
      1000,
    );

    const spanX = base.maxX - base.minX || 1;
    const spanY = base.maxY - base.minY || 1;
    const aspect = spanY / spanX;
    const planeW = 10;
    const planeH = 10 * aspect;

    const geo = new THREE.PlaneGeometry(planeW, planeH, cols - 1, rows - 1);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.05,
      flatShading: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);

    // A dim base plate so the footprint stays legible where the surface is low.
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(planeW * 1.02, planeH * 1.02),
      new THREE.MeshBasicMaterial({
        color: 0x1b1f26,
        transparent: true,
        opacity: 0.35,
      }),
    );
    plate.rotateX(-Math.PI / 2);
    plate.position.y = -0.01;
    scene.add(plate);

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(6, 12, 4);
    scene.add(key);

    camera.position.set(0, planeH * 1.5 + 6, planeH * 1.4 + 6);
    camera.lookAt(0, 0, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2.05; // never go under the plate

    let raf = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    const onResize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    const dispose = () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
    };

    sceneRef.current = { renderer, scene, camera, controls, mesh, geo, dispose };
    return dispose;
    // Rebuild only when the grid shape changes; frame changes are tweened.
  }, [fields.length ? `${fields[0].cols}x${fields[0].rows}` : "empty"]);

  // --- frame application (tweened) ---------------------------------------
  useEffect(() => {
    const s = sceneRef.current;
    const field = fields[frame];
    if (!s || !field) return;

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

    const base = new THREE.Color(color);
    const grey = new THREE.Color(0x8a8f98);

    const apply = (t: number) => {
      for (let v = 0; v < vertexCount; v++) {
        const y = from[v] + (target[v] - from[v]) * t;
        pos.setY(v, y);
        // Desaturate by confidence: pale ground is estimated, not measured.
        // Never expressed as height — that would be a claim about counts.
        const conf = targetConf[v];
        const lift = peak > 0 ? Math.min(1, (target[v] / heightScale) / peak) : 0;
        const col = grey.clone().lerp(base, 0.25 + 0.75 * conf);
        col.multiplyScalar(0.55 + 0.45 * lift);
        colAttr.setXYZ(v, col.r, col.g, col.b);
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
  }, [frame, fields, peak, color]);

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
        No fully-scouted week in this range. A greenhouse needs both bed halves
        scouted in the same week before its terrain can be drawn.
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div
        ref={mountRef}
        className="min-h-[360px] w-full flex-1 overflow-hidden rounded-md border bg-[#0d1014]"
      />

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

      {/* Timeline: skipped weeks keep their slot, so a gap reads as missing
          data rather than as a quiet week. */}
      <div className="flex flex-wrap items-center gap-1">
        {marks.map((m) => (
          <button
            key={m.week.date}
            type="button"
            disabled={!m.playable}
            onClick={() => m.frame !== null && setFrame(m.frame)}
            title={
              m.playable
                ? m.week.date
                : `${m.week.date} — only one bed half scouted, skipped`
            }
            className={cn(
              "h-1.5 w-6 rounded-full transition-colors",
              !m.playable
                ? "cursor-not-allowed bg-muted-foreground/25"
                : m.frame === frame
                ? "bg-foreground"
                : "bg-muted-foreground/60 hover:bg-foreground/70",
            )}
          />
        ))}
      </div>

      <p className="text-[0.65rem] leading-snug text-muted-foreground">
        Height = observations per zone, scaled across all shown weeks (peak ={" "}
        {peak.toFixed(1)}). Pale ground is <strong>estimated</strong> from nearby
        scouted zones, not measured — unscouted beds are interpolated, never
        drawn as dips. Faded ticks are weeks where only one bed half was scouted.
      </p>
    </div>
  );
}
