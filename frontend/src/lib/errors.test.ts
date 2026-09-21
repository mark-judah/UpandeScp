/**
 * The translator is judged on the strings this deployment actually produces.
 *
 * Every "real" case below was taken from the live site's Error Log or from an
 * error we hit while putting the spray flow through on the live site, not from
 * a guess about what Frappe might say.
 */

import { describe, expect, it } from "vitest";

import { asStatement, errorText, explainError } from "./errors";
import { FrappeError } from "./frappe";

const frappeThrow = (message: string, status = 417) =>
  new FrappeError(`frappe.exceptions.ValidationError: ${message}`, status, {
    exception: `frappe.exceptions.ValidationError: ${message}`,
    _server_messages: JSON.stringify([JSON.stringify({ message, title: "Message" })]),
  });

describe("the site is busy or away", () => {
  it("does not show a farm manager a lock manager's diagnostics", () => {
    // 63 of these on the live site in three weeks — the most common error there is.
    const h = explainError(
      "frappe.exceptions.QueryDeadlockError: (1213, 'Deadlock found when trying to get lock; try restarting transaction')",
    );
    expect(h.kind).toBe("site");
    expect(h.text).not.toMatch(/deadlock|1213|lock/i);
    expect(h.hint).toMatch(/try again/i);
  });

  it("reads a restart as a restart", () => {
    const h = explainError("frappe.exceptions.SessionStopped: Session Stopped");
    expect(h.text).toMatch(/restarting/i);
    expect(h.kind).toBe("site");
  });

  it("says nothing was sent when the network dropped", () => {
    expect(explainError(new TypeError("Failed to fetch")).text).toMatch(/could not reach/i);
  });
});

describe("the site's own shape is wrong", () => {
  it("names the missing field and says whose fault it is", () => {
    const h = explainError(`MySQLdb.OperationalError: (1054, "Unknown column 'irac_code' in 'SELECT'")`);
    expect(h.text).toContain("irac_code");
    expect(h.text).not.toMatch(/1054|SELECT|MySQLdb/);
    expect(h.hint).toMatch(/data is fine/i);
    expect(h.kind).toBe("bug");
  });

  it("handles a missing table the same way", () => {
    const h = explainError(
      `MySQLdb.ProgrammingError: (1146, "Table '_1347eead1afa372b.tabCrop Husbandry Practices Entry' doesn't exist")`,
    );
    expect(h.text).toContain("Crop Husbandry Practices Entry");
    expect(h.text).not.toMatch(/1347eead|tab[A-Z]/);
    expect(h.kind).toBe("bug");
  });

  it("does not blame the operator for a NoneType", () => {
    const h = explainError("builtins.TypeError: 'NoneType' object is not iterable");
    expect(h.kind).toBe("bug");
    expect(h.text).not.toMatch(/NoneType|iterable/);
    expect(h.hint).toMatch(/not in what you entered/i);
  });
});

describe("the spray flow's accounting failures", () => {
  it("explains the cost-centre block and where to fix it", () => {
    // The live error that stopped MAT-STE-2026-100001717.
    const h = explainError(frappeThrow("Cost Center is mandatory for Item 1111156005"));
    expect(h.text).toContain("1111156005");
    expect(h.text).toMatch(/cost centre/i);
    expect(h.hint).toMatch(/Settings → Accounts/);
    expect(h.kind).toBe("user");
  });

  it("reads a zero transfer cap as 'already sent', not as a number", () => {
    const h = explainError(frappeThrow("Maximum transferable quantity is 0.0"));
    expect(h.text).toMatch(/already been transferred/i);
  });

  it("keeps a non-zero cap as the number it is", () => {
    expect(explainError(frappeThrow("Maximum transferable quantity is 12.5")).text).toContain("12.5");
  });

  it("turns a valuation gap into an instruction", () => {
    const h = explainError(frappeThrow("Valuation Rate for the Item is required"));
    expect(h.text).toMatch(/no value recorded/i);
    expect(h.hint).toMatch(/receive some stock/i);
  });
});

describe("permissions", () => {
  it("says what they cannot open and who to ask", () => {
    const h = explainError(
      frappeThrow(
        "You need the 'read' permission on Material Request MAT-MR-2026-10793 to perform this action.",
        403,
      ),
    );
    expect(h.text).toContain("MAT-MR-2026-10793");
    expect(h.text).toMatch(/permission to open/i);
    expect(h.hint).toMatch(/administrator/i);
  });

  it("treats a stale session as a reload, not a permission problem", () => {
    const h = explainError(new FrappeError("Invalid CSRF Token", 403, {}));
    expect(h.text).toMatch(/session has expired/i);
    expect(h.hint).toMatch(/reload/i);
  });
});

describe("messages we wrote ourselves", () => {
  it("passes them through rather than talking over them", () => {
    const ours = "Cost Center 'Karen GH9 - KR' is disabled";
    const h = explainError(frappeThrow(ours));
    expect(h.text).toBe("Cost Center 'Karen GH9 - KR' is disabled.");
    expect(h.translated).toBe(false);
  });

  it("prefers _server_messages over the exception line", () => {
    const e = new FrappeError("frappe.exceptions.ValidationError: raw and ugly", 417, {
      exception: "frappe.exceptions.ValidationError: raw and ugly",
      _server_messages: JSON.stringify([
        JSON.stringify({ message: "Pick at least one target before submitting" }),
      ]),
    });
    expect(explainError(e).text).toBe("Pick at least one target before submitting.");
  });

  it("strips the HTML Frappe wraps messages in", () => {
    const e = new FrappeError("x", 417, {
      _server_messages: JSON.stringify([
        JSON.stringify({ message: "<b>Row #1</b>: Rate must be &gt; 0<br>Fix it" }),
      ]),
    });
    expect(explainError(e).text).toBe("Row #1: Rate must be > 0 Fix it.");
  });
});

describe("when we genuinely do not know", () => {
  it("admits it instead of printing Python", () => {
    const h = explainError("builtins.NameError: name '_unpack_sequence_' is not defined");
    expect(h.translated).toBe(false);
    expect(h.kind).toBe("unknown");
    expect(h.text).not.toMatch(/NameError|_unpack_sequence_/);
  });

  it("uses the caller's fallback when given one", () => {
    expect(explainError("", "Could not create the tank mix").text).toBe("Could not create the tank mix");
  });

  it("never returns an empty string", () => {
    for (const e of [null, undefined, "", {}, new Error("")]) {
      expect(errorText(e).length).toBeGreaterThan(0);
    }
  });
});

describe("asStatement", () => {
  it("finishes a sentence that was left open", () => {
    expect(asStatement("Add at least one chemical")).toBe("Add at least one chemical.");
  });
  it("leaves one that already ended alone", () => {
    expect(asStatement("Add at least one chemical.")).toBe("Add at least one chemical.");
    expect(asStatement("Ready?")).toBe("Ready?");
  });
  it("collapses the whitespace Frappe leaves behind", () => {
    expect(asStatement("  Rate   must be > 0  ")).toBe("Rate must be > 0.");
  });
});
