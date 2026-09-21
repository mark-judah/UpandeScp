/**
 * Turn a server error into something a farm manager can act on.
 *
 * Frappe hands the browser whatever Python raised. Some of that is already
 * ours and already English — a `frappe.throw` we wrote — and it only needs its
 * Python class name peeled off. The rest is machine talk that means nothing to
 * a spray supervisor at 6am:
 *
 *     frappe.exceptions.QueryDeadlockError: (1213, 'Deadlock found when trying
 *     to get lock; try restarting transaction')
 *
 * That is the single most common error on the live site, and there is nothing
 * wrong with the operator's data — the site was just busy. They should be told
 * to try again, not shown a lock manager's diagnostics.
 *
 * The rules below are drawn from the site's own Error Log rather than from
 * imagination: 1213 deadlocks, 1054 unknown columns, 1146 missing tables,
 * SessionStopped restarts, and the ERPNext stock/accounting validations the
 * spray flow trips.
 *
 * Two principles:
 *
 *   1. Never invent certainty. Where we cannot tell what went wrong we say so
 *      plainly and keep the raw text for whoever is debugging.
 *   2. Never talk over ourselves. A message we wrote is already aimed at this
 *      user, so it passes through cleaned but unrewritten.
 */

import { FrappeError } from "./frappe";

export interface HumanError {
  /** One sentence, addressed to the person looking at the screen. */
  text: string;
  /** What to do about it, when there is something to do. */
  hint?: string;
  /** The server's own words, kept for the console and bug reports. */
  raw: string;
  /** Set when a rule matched. False means `text` is a cleaned passthrough. */
  translated: boolean;
  /** Whether this is the user's to fix, or ours. */
  kind: "user" | "site" | "bug" | "unknown";
}

interface Rule {
  test: RegExp;
  /** `m` is the RegExp match, so a rule can quote the offending name back. */
  to: (m: RegExpMatchArray) => { text: string; hint?: string; kind: HumanError["kind"] };
}

/* ── Pulling the message out of whatever was thrown ─────────────── */

/** Frappe puts the message from `frappe.throw` in `_server_messages` — a JSON
 *  array of JSON strings. That is the one written for a human; `exception` is
 *  the same text wearing a Python class name. Prefer the former. */
function serverMessages(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const raw = (payload as Record<string, unknown>)._server_messages;
  if (typeof raw !== "string") return [];
  try {
    const outer = JSON.parse(raw);
    if (!Array.isArray(outer)) return [];
    return outer
      .map((entry) => {
        if (typeof entry !== "string") return "";
        try {
          const inner = JSON.parse(entry);
          return typeof inner === "string" ? inner : String(inner?.message ?? "");
        } catch {
          return entry;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ",
};

/** Frappe messages are HTML fragments — `<br>`, `<b>`, entity-encoded quotes. */
function stripHtml(s: string): string {
  return s
    .replace(/<\s*br\s*\/?\s*>/gi, " ")
    .replace(/<\/\s*(p|div|li)\s*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/gi, (e) => HTML_ENTITIES[e.toLowerCase()] ?? e)
    .replace(/\s+/g, " ")
    .trim();
}

/** `frappe.exceptions.ValidationError: Rate must be > 0` -> `Rate must be > 0`. */
function stripExceptionClass(s: string): string {
  return s.replace(/^(?:[a-zA-Z_][\w.]*\.)?[A-Za-z]*(?:Error|Exception)\s*:\s*/, "").trim();
}

/** The last exception line of a traceback is the only part that carries meaning. */
function lastTracebackLine(s: string): string {
  if (!/traceback \(most recent call last\)/i.test(s)) return s;
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^(?:[a-zA-Z_][\w.]*\.)?[A-Za-z]*(?:Error|Exception)\b/.test(lines[i])) return lines[i];
  }
  return lines[lines.length - 1] ?? s;
}

function rawTextOf(e: unknown): string {
  if (e instanceof FrappeError) {
    const fromServer = serverMessages(e.payload);
    if (fromServer.length) return fromServer.join(" ");
    return e.message;
  }
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e ?? "");
}

/* ── The rules, most specific first ─────────────────────────────── */

const RULES: Rule[] = [
  // ---- The site is busy or away. Nothing is wrong with the data. ----
  {
    test: /deadlock found when trying to get lock|\b1213\b/i,
    to: () => ({
      text: "The site was handling another change at the same moment, so this one was rolled back.",
      hint: "Nothing was saved. Try again.",
      kind: "site",
    }),
  },
  {
    test: /session\s*stopped|\b(?:502|503|504)\b|bad gateway|service unavailable|gateway time-?out/i,
    to: () => ({
      text: "The site is restarting and could not take that just now.",
      hint: "Give it a moment and try again.",
      kind: "site",
    }),
  },
  {
    test: /failed to fetch|networkerror|network request failed|load failed/i,
    to: () => ({
      text: "Could not reach the site.",
      hint: "Check the connection and try again. Nothing was sent.",
      kind: "site",
    }),
  },
  {
    test: /lock wait timeout exceeded/i,
    to: () => ({
      text: "Another change is holding this record and did not let go in time.",
      hint: "Nothing was saved. Try again in a moment.",
      kind: "site",
    }),
  },

  // ---- The site's own shape is wrong. Ours to fix, not theirs. ----
  {
    test: /unknown column '([^']+)'/i,
    to: (m) => ({
      text: `This page asked for "${m[1]}", which no longer exists on the site.`,
      hint: "Your data is fine — the page needs updating. Report it.",
      kind: "bug",
    }),
  },
  {
    test: /table '[^']*\.tab([^']+)' doesn't exist/i,
    to: (m) => ({
      text: `This page expects ${m[1]} records, which this site does not have.`,
      hint: "Nothing you can fix from here — report it.",
      kind: "bug",
    }),
  },
  {
    test: /no such file or directory:.*[/\\]([^/\\'"]+)['"]?$/i,
    to: (m) => ({
      text: `The file "${m[1]}" is missing from the site.`,
      hint: "It was recorded but never stored, or has since been removed.",
      kind: "bug",
    }),
  },
  {
    test: /'nonetype' object|is not iterable|is not subscriptable|unhashable type/i,
    to: () => ({
      text: "Something was missing that this page expected to be there.",
      hint: "This is a fault on our side, not in what you entered. Report it.",
      kind: "bug",
    }),
  },

  // ---- Accounting and stock: the spray flow's real failures. ----
  {
    test: /cost cent(?:er|re) is mandatory for item\s+(\S+)/i,
    to: (m) => ({
      text: `Item ${m[1]} has no cost centre to charge the spend to.`,
      hint: "Turn on the greenhouse cost centre in Settings → Accounts, or set a default cost centre on the company.",
      kind: "user",
    }),
  },
  {
    test: /valuation rate .*?(?:is )?(?:required|not found|missing)|please set valuation rate/i,
    to: () => ({
      text: "This chemical has no value recorded yet, so the entry cannot be costed.",
      hint: "Receive some stock for it first, or set its valuation rate.",
      kind: "user",
    }),
  },
  {
    test: /maximum transferable quantity is\s*([\d.]+)/i,
    to: (m) =>
      Number(m[1]) === 0
        ? {
            text: "This plan's chemicals have already been transferred in full.",
            hint: "There is nothing left to send to the CSU for it.",
            kind: "user",
          }
        : {
            text: `Only ${m[1]} of this can still be transferred for the plan.`,
            hint: "Reduce the quantity to what the plan still needs.",
            kind: "user",
          },
  },
  {
    test: /cannot be greater than planned quantity/i,
    to: () => ({
      text: "That is more than the plan asked for.",
      hint: "Reduce the quantity, or amend the plan.",
      kind: "user",
    }),
  },
  {
    test: /negative stock|insufficient stock|not available|required quantity.*not available/i,
    to: (m) => ({
      text: stripHtml(m.input ?? "").replace(/^negative stock error\s*/i, ""),
      hint: "There is not enough in that store. Check the quantity or the store.",
      kind: "user",
    }),
  },

  // ---- Permissions, links, duplicates. ----
  {
    test: /you need the '?(\w+)'? permission on ([^\s]+(?:\s+[A-Z][\w-]*)?)\s+(\S+)/i,
    to: (m) => ({
      text: `You do not have permission to ${m[1] === "read" ? "open" : m[1]} ${m[3]}.`,
      hint: "Ask an administrator to give you access to it.",
      kind: "user",
    }),
  },
  {
    test: /not permitted|permissionerror|insufficient permission/i,
    to: () => ({
      text: "You do not have permission to do that.",
      hint: "Ask an administrator if you think you should.",
      kind: "user",
    }),
  },
  {
    test: /duplicate entry '([^']+)'|already exists/i,
    to: (m) => ({
      text: m[1] ? `"${m[1]}" already exists.` : "That already exists.",
      hint: "Open the existing one rather than creating a second.",
      kind: "user",
    }),
  },
  {
    test: /could not find ([\w\s]+?):\s*(\S+)/i,
    to: (m) => ({
      text: `${m[2]} is not on this site${m[1] ? ` as a ${m[1].trim()}` : ""}.`,
      hint: "It may have been renamed or removed.",
      kind: "user",
    }),
  },
  {
    test: /document has been modified|timestampmismatch/i,
    to: () => ({
      text: "Someone else changed this while you had it open.",
      hint: "Reload the page so you are working from their version, then try again.",
      kind: "user",
    }),
  },
  {
    test: /cannot delete or cancel because|linkexists/i,
    to: (m) => ({
      text: stripHtml(m.input ?? ""),
      hint: "Remove the link first, then try again.",
      kind: "user",
    }),
  },

  // ---- Housekeeping the operator cannot action. ----
  {
    test: /setup default outgoing email account/i,
    to: () => ({
      text: "The site cannot send email — no outgoing account is set up.",
      hint: "Everything else saved. An administrator needs to configure email.",
      kind: "site",
    }),
  },
];

/* ── The public shape ───────────────────────────────────────────── */

/** Frappe exceptions whose message was written for the person on the screen —
 *  everything raised by a `frappe.throw`. Anything else that reaches the
 *  browser is an accident, and its message is aimed at a developer. */
const USER_FACING_EXCEPTIONS = new Set([
  "ValidationError", "MandatoryError", "PermissionError", "DoesNotExistError",
  "LinkValidationError", "LinkExistsError", "DuplicateEntryError",
  "TimestampMismatchError", "InvalidStatusError", "UniqueValidationViolation",
  "UpdateAfterSubmitError", "CancelledLinkError", "EmptyTableError",
  "InvalidNameError", "DataError",
]);

/** True when the message was written for a developer, not for this user.
 *
 *  Judged on the exception class rather than the wording, because stripping
 *  `builtins.NameError:` off the front leaves "name '_unpack_sequence_' is not
 *  defined" — a sentence, in English, and completely useless to a supervisor. */
function machineWritten(original: string, cleaned: string): boolean {
  const m = original.match(/^\s*((?:[\w.]+\.)?)([A-Za-z]\w*(?:Error|Exception))\s*:/);
  if (m) {
    const module = m[1].replace(/\.$/, "");
    if (module === "builtins" || /MySQLdb|pymysql|sqlalchemy|redis|socket|urllib/i.test(module)) {
      return true;
    }
    if (!USER_FACING_EXCEPTIONS.has(m[2])) return true;
  }
  return (
    /\(\d{4},/.test(cleaned) ||                       // (1054, "...")
    /\b[a-z_]+\.[a-z_]+Error\b/i.test(cleaned) ||     // module.SomeError
    /Traceback/i.test(cleaned) ||
    /\bself\.\w+|<[a-z]+ object at 0x/i.test(cleaned) ||
    !cleaned.trim()
  );
}

export function explainError(e: unknown, fallback?: string): HumanError {
  const original = rawTextOf(e);
  const cleaned = stripExceptionClass(stripHtml(lastTracebackLine(original)));

  // A stale page is its own thing: every later request will fail the same way,
  // so the only useful instruction is to reload.
  if (e instanceof FrappeError && e.isStaleSession) {
    return {
      text: "Your session has expired.",
      hint: "Reload the page and sign in again — nothing you entered was sent.",
      raw: original,
      translated: true,
      kind: "site",
    };
  }

  for (const rule of RULES) {
    const m = cleaned.match(rule.test);
    if (!m) continue;
    // `m.input` lets a passthrough rule hand back the whole sentence.
    const out = rule.to(m);
    if (!out.text) break;
    return { ...out, raw: original, translated: true };
  }

  if (machineWritten(stripHtml(lastTracebackLine(original)), cleaned)) {
    return {
      text: fallback || "Something went wrong and this could not be saved.",
      hint: "Nothing was changed. Try again, and report it if it keeps happening.",
      raw: original,
      translated: false,
      kind: "unknown",
    };
  }

  // Ours already, and already aimed at this person. Say it as a sentence.
  return {
    text: asStatement(cleaned),
    raw: original,
    translated: false,
    kind: "user",
  };
}

/** One line, for a toast that has room for one line. */
export function errorText(e: unknown, fallback?: string): string {
  const h = explainError(e, fallback);
  return h.hint ? `${h.text} ${h.hint}` : h.text;
}

/** Sentence case with a full stop — every message reads the same way. */
export function asStatement(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (!t) return t;
  const ended = /[.!?]$/.test(t) || /[.!?]["')\]]$/.test(t);
  return ended ? t : `${t}.`;
}
