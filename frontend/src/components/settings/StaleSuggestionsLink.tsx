/**
 * "N plans suggested for cancelling — review": the count of plans whose hold has run out,
 * linking to the stale list on the Approvals page where they are cancelled by hand.
 * Nothing is cancelled automatically.
 */
import { useEffect, useState } from "react";
import { getStalePlans } from "@/lib/scouting-api";
import { cropSlug, routeCrop } from "@/lib/router";

export function StaleSuggestionsLink() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    getStalePlans()
      .then((r) => live && setCount(r.length))
      .catch(() => live && setCount(null));
    return () => {
      live = false;
    };
  }, []);

  if (count === null) return null;
  const href = `#/${cropSlug(routeCrop())}/approvals?tab=stale`;
  return (
    <p className="mt-2 text-[0.7rem]" data-testid="stale-suggestions">
      <a href={href} className="font-medium underline underline-offset-2">
        {count} plan{count === 1 ? "" : "s"} suggested for cancelling — review
      </a>
    </p>
  );
}
