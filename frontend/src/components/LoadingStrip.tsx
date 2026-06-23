import { cn } from "@/lib/utils";

/**
 * Slow pulsing strip used at the bottom of pages while background data is
 * loading. Sits flush with the page edge — no header chrome, no progress
 * percentage. Reassures the user without competing with the content.
 */
export function LoadingStrip({
  active,
  className,
}: {
  active: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden={!active}
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 z-40 h-0.5 overflow-hidden transition-opacity duration-300",
        active ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      <div className="absolute inset-0 bg-[var(--sd-line)]" />
      <div className="absolute inset-y-0 w-1/3 animate-[scp-strip_2s_ease-in-out_infinite] rounded-full bg-[var(--sd-accent)]" />
      <style>{`
        @keyframes scp-strip {
          0%   { transform: translateX(-100%); }
          50%  { transform: translateX(150%); }
          100% { transform: translateX(150%); }
        }
      `}</style>
    </div>
  );
}
