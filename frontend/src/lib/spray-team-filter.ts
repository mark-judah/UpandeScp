/**
 * Scope spray teams to a greenhouse's farm. A team shows when its custom_farm
 * matches the farm (case-insensitive) OR is empty/null (treated as global).
 * When no farm is known yet, all teams show. Teams tagged to a different farm
 * are hidden.
 */
export function filterTeamsByFarm<T extends { custom_farm?: string | null }>(
  teams: T[],
  farm: string,
): T[] {
  const f = (farm || "").trim().toLowerCase();
  if (!f) return teams;
  return teams.filter((t) => {
    const tf = (t.custom_farm || "").trim().toLowerCase();
    return !tf || tf === f;
  });
}
