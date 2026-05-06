// Typed wrappers for the scouting dashboard endpoints.
// Mirrors legacy fetch calls in www/scouting_dashboard.js.

import { call } from "@/lib/frappe"

export interface PestObservation {
  pest: string
  plant_section?: string | null
  stage?: string | null
  count?: number | null
}

export interface DiseaseObservation {
  disease: string
  plant_section?: string | null
  stage?: string | null
}

export interface TrapObservation {
  trap: string
  pest?: string | null
  location?: string | null
  count?: number | null
}

export interface ScoutingEntry {
  name: string
  scouts_name?: string | null
  greenhouse?: string | null
  bed?: string | null
  zone?: string | number | null
  date_of_capture: string
  time_of_capture?: string | null
  owner?: string | null
  modified_by?: string | null
  // Children (Python returns these aliases, NOT *_scouting_entry):
  pests?: PestObservation[]
  diseases?: DiseaseObservation[]
  traps?: TrapObservation[]
}

export interface PestColor {
  pest?: string
  name?: string
  color?: string
}
export interface DiseaseColor {
  disease?: string
  name?: string
  color?: string
}

export interface ScoutingPayload {
  entries: ScoutingEntry[]
  total_entries: number
  filters_applied: { from_date: string; to_date: string; greenhouse: string | null }
  pest_colors?: PestColor[]
  disease_colors?: DiseaseColor[]
  zones_by_greenhouse?: Record<string, number>
}

export const scoutingApi = {
  getCompleteScoutingEntries: (args: {
    from_date: string
    to_date: string
    greenhouse?: string | null
  }) =>
    call<ScoutingPayload>(
      "upande_scp.serverscripts.get_complete_scouting_entries.getCompleteScoutingEntries",
      args,
    ),

  getScoutingEntriesChunk: (args: {
    from_date: string
    to_date: string
    greenhouse?: string | null
    include_meta?: 0 | 1
  }) =>
    call<ScoutingPayload>(
      "upande_scp.serverscripts.get_complete_scouting_entries.getScoutingEntriesChunk",
      args,
    ),

  // List distinct greenhouses observed in Scouting Entry.
  // Tries group_by first; some Frappe versions don't support that for whitelisted get_list,
  // so fall back to a plain list and dedupe client-side.
  listScoutedGreenhouses: async (): Promise<string[]> => {
    try {
      const r = await call<Array<{ greenhouse?: string | null }>>(
        "frappe.client.get_list",
        {
          doctype: "Scouting Entry",
          fields: ["greenhouse"],
          group_by: "greenhouse",
          order_by: "greenhouse asc",
          limit_page_length: 5000,
        },
      )
      return Array.from(new Set((r ?? []).map((d) => d.greenhouse).filter(Boolean) as string[]))
    } catch {
      const r = await call<Array<{ greenhouse?: string | null }>>(
        "frappe.client.get_list",
        {
          doctype: "Scouting Entry",
          fields: ["greenhouse"],
          order_by: "greenhouse asc",
          limit_page_length: 5000,
        },
      )
      return Array.from(new Set((r ?? []).map((d) => d.greenhouse).filter(Boolean) as string[]))
    }
  },

  // Most recent scouting capture date — used to default the week filter.
  latestScoutingDate: async (): Promise<string | null> => {
    const r = await call<Array<{ date_of_capture?: string }>>(
      "frappe.client.get_list",
      {
        doctype: "Scouting Entry",
        fields: ["date_of_capture"],
        order_by: "date_of_capture desc",
        limit_page_length: 1,
      },
    )
    return r?.[0]?.date_of_capture ?? null
  },
}

// ----------------------------- Focus pests (FCM tab) ---------------------------

export interface FocusPest {
  key: string
  label: string
  matches: (name: string) => boolean
}

const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z]+/g, " ").trim()
const matchesAny = (s: string, needles: string[]) => needles.some((n) => s.includes(n))

export const FOCUS_PESTS: FocusPest[] = [
  {
    key: "fcm",
    label: "FCM",
    matches: (n) => matchesAny(norm(n), ["fcm", "false codling", "false codling moth"]),
  },
  {
    key: "helicoverpa",
    label: "Helicoverpa",
    matches: (n) => matchesAny(norm(n), ["helicoverpa", "helioverpa"]),
  },
  {
    key: "duponchella",
    label: "Duponchella",
    matches: (n) => matchesAny(norm(n), ["duponchella", "duponchelia", "duponchel"]),
  },
  {
    key: "spodoptera",
    label: "Spodoptera",
    matches: (n) => matchesAny(norm(n), ["spodoptera", "armyworm", "fall armyworm"]),
  },
  {
    key: "unidentified_moth",
    label: "Unidentified moth",
    matches: (n) => {
      const s = norm(n)
      return (
        matchesAny(s, ["unidentified moth", "unknown moth"]) ||
        (s.includes("unidentified") && s.includes("moth"))
      )
    },
  },
]

export const focusKey = (name: string): string | null => {
  for (const f of FOCUS_PESTS) if (f.matches(name)) return f.key
  return null
}

export const focusLabel = (key: string): string =>
  FOCUS_PESTS.find((f) => f.key === key)?.label ?? key

// ----------------------------- Date / week helpers -----------------------------

export const getIsoWeekString = (date: Date): string => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((+d - +yearStart) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`
}

export const parseWeekValue = (value: string): { year: number; week: number } | null => {
  const m = value.match(/^(\d{4})-W(\d{1,2})$/)
  if (!m) return null
  return { year: Number(m[1]), week: Number(m[2]) }
}

const formatDateYmd = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`

export const isoWeekDateRange = (year: number, week: number): { from: string; to: string } => {
  // ISO week starts on Monday; week 1 contains the year's first Thursday.
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7))
  const dayOfWeek = simple.getUTCDay()
  const monday = new Date(simple)
  if (dayOfWeek <= 4) {
    monday.setUTCDate(simple.getUTCDate() - simple.getUTCDay() + 1)
  } else {
    monday.setUTCDate(simple.getUTCDate() + 8 - simple.getUTCDay())
  }
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  return { from: formatDateYmd(monday), to: formatDateYmd(sunday) }
}

export const rangeFromWeeks = (
  fromIso: string,
  toIso: string,
): { from: string; to: string } | null => {
  const a = parseWeekValue(fromIso)
  const b = parseWeekValue(toIso)
  if (!a || !b) return null
  const ar = isoWeekDateRange(a.year, a.week)
  const br = isoWeekDateRange(b.year, b.week)
  return { from: ar.from, to: br.to }
}
