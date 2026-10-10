/**
 * Domain icons from the one shared set (item 9b).
 *
 * The source is `upande_scp/shared/icons/<category>/<key>.svg`; the generator
 * (`scripts/build_icons.mjs`) folds it into `manifest.json`, which this reads.
 * Generic UI icons stay lucide-react — this is only for the shapes the farm
 * owns: stage markers, weather, notices and the brand mark.
 *
 * `name` is "<category>/<key>", e.g. "stage/star". Anything unknown falls back
 * to the default stage shape (the circle) so a caller always draws something.
 */
import type { CSSProperties } from "react";
import manifest from "@shared/icons/manifest.json";

export type SharedIconDef = {
  category: string;
  key: string;
  viewBox: string;
  attrs: Record<string, string>;
  body: string;
};

const ICONS = manifest.icons as Record<string, SharedIconDef>;
export const DEFAULT_STAGE_KEY: string = manifest.defaultStageKey;

/** Look up an icon, falling back to the default stage shape. */
export function sharedIcon(name: string | null | undefined): SharedIconDef {
  return ICONS[name || ""] ?? ICONS[`stage/${DEFAULT_STAGE_KEY}`];
}

/** Icons of one category, keyed by their key. */
export function sharedIconsOf(category: string): Record<string, SharedIconDef> {
  const out: Record<string, SharedIconDef> = {};
  for (const i of Object.values(ICONS)) if (i.category === category) out[i.key] = i;
  return out;
}

const camel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** The icon's root attributes as React SVG props (stroke-width → strokeWidth). */
export function svgProps(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) out[camel(k)] = v;
  return out;
}

export function SharedIcon({
  name,
  size = 16,
  fill,
  stroke,
  className,
  style,
  title,
}: {
  name: string;
  size?: number | string;
  fill?: string;
  stroke?: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const icon = sharedIcon(name);
  const props = svgProps(icon.attrs);
  if (fill !== undefined) props.fill = fill;
  if (stroke !== undefined) props.stroke = stroke;
  const body = title ? `<title>${escapeXml(title)}</title>${icon.body}` : icon.body;
  return (
    <svg
      viewBox={icon.viewBox}
      width={size}
      height={size}
      className={className}
      style={style}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      {...props}
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

function escapeXml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
