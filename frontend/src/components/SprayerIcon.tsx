import { SharedIcon } from "@/components/SharedIcon";

/** SCP's own sprayer pictogram (shared/icons/brand/sprayer.svg): a sprayer with a backpack
 *  tank, lance and drops. Drop-in for a lucide icon: takes a className for size/colour. */
export function SprayerIcon({ className }: { className?: string }) {
  return <SharedIcon name="brand/sprayer" size="1em" className={className} />;
}
