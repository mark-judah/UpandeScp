/**
 * Banner under the team picker: who takes charge of the spray, and whether each
 * supervisor can actually run it on the phone (a user with the Spray Supervisor
 * role). The result comes live from the server whenever the team or a role changes;
 * a failed call just hides the badges, it never blocks planning.
 */
import { useEffect, useState } from "react";
import { BadgeCheck, ShieldAlert, UserX } from "lucide-react";
import {
  checkSprayTeam,
  type SprayTeamCheck,
  type SupervisorCheckRow,
} from "@/lib/spray-plan-creator-api";

const BADGE: Record<
  SupervisorCheckRow["status"],
  { label: string; cls: string; Icon: typeof BadgeCheck }
> = {
  ok: { label: "Role assigned", cls: "text-emerald-700", Icon: BadgeCheck },
  missing_role: { label: "Missing Spray Supervisor role", cls: "text-amber-700", Icon: ShieldAlert },
  no_user: { label: "No user account", cls: "text-red-700", Icon: UserX },
};

export function SupervisorBanner({
  team,
  members,
}: {
  team: string;
  members: { employee: string; employee_name?: string; role: string }[];
}) {
  const [check, setCheck] = useState<SprayTeamCheck | null>(null);
  const key = JSON.stringify([team, members.map((m) => [m.employee, m.role])]);
  const supervisors = members.filter((m) => m.role === "Supervisor");

  useEffect(() => {
    if (!supervisors.length) {
      setCheck(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      checkSprayTeam(team, members.map((m) => ({ employee: m.employee, role: m.role })))
        .then((r) => alive && setCheck(r))
        .catch(() => alive && setCheck(null));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const byEmp = new Map((check?.supervisors || []).map((s) => [s.employee, s]));

  return (
    <div
      role="note"
      data-testid="supervisor-banner"
      className="flex flex-col gap-1.5 rounded-lg bg-muted/60 px-3 py-2 text-[0.72rem] leading-snug"
    >
      <p className="text-muted-foreground">
        The spray supervisor named here takes charge of all spray operations for this plan
        tomorrow. If that is not right, assign the supervisor role to the person who will.
      </p>
      {supervisors.length === 0 ? (
        <p className="font-medium text-amber-700">
          No supervisor chosen yet. Mark one team member as Supervisor.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {supervisors.map((m) => {
            const row = byEmp.get(m.employee);
            const b = row ? BADGE[row.status] : null;
            return (
              <li key={m.employee} className="flex flex-wrap items-center gap-x-2">
                <span className="font-semibold">{m.employee_name || m.employee}</span>
                {b && (
                  <span className={`inline-flex items-center gap-1 ${b.cls}`} title={row?.message || undefined}>
                    <b.Icon className="h-3.5 w-3.5" />
                    {b.label}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {supervisors.length > 2 && (
        <p className="font-medium text-red-700">A plan can have at most 2 supervisors.</p>
      )}
    </div>
  );
}
