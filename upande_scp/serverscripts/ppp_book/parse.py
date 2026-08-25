"""Pure parsing of the Plant Protection Products workbook.

No database access — everything here is testable without a site. The workbook
groups products under target section headers (a row with only column A filled);
that grouping is the targets data.

Sheet1 is Mona's own book. Sheet2 is Equator Flowers Kenya Limited's; it may
contribute targets only, never a rate — the two farms disagree on rates for 31
of 58 shared products, and a rate gates what physically goes in a sprayer.
"""
from __future__ import annotations

import re

import openpyxl

DEFAULT_WORKBOOK = (
    "/home/ubuntu/stive/code/frappe15/apps/upande_scp/"
    "doc references/monadocs/PLANT PROTECTION PRODUCTS And Suppliers.xlsx"
)

MONA_SHEET = "Sheet1"

# Column layout differs between the two sheets (Sheet2 has an extra
# "CHEMICAL GROUP" column before FRAC/IRAC).
#                 codes, form, rate, toxicity
_COLS = {True: (5, 6, 7, 9), False: (6, 7, 8, None)}

# Sheet section header -> master names. An empty list means "not a pest or
# disease": the section's products contribute no targets.
TARGET_ALIASES = {
    "agrobacteria": ["Agrobacterium"],
    "downey mildew": ["Downy Mildew"],
    "downy mildew": ["Downy Mildew"],
    "powdery mildew": ["Powdery Mildew"],
    "botrytis": ["Botrytis"],
    "mites": ["Spidermites"],
    "thrips": ["Thrips"],
    "aphids": ["Aphids"],
    "aphids/ m bugs": ["Aphids", "Mealybugs"],
    "caterpillars": ["Caterpillars"],
    "nematodes": ["Nematodes"],
    "p/harvest": [],
}

# WHO hazard column: Excel flattened the Roman numerals to digits.
TOXICITY_REPAIR = {
    "1": "I", "11": "II", "111": "III", "1111": "IV",
    "I": "I", "II": "II", "III": "III", "IV": "IV",
}

# Tokens that appear in the FRAC/IRAC column but are not resistance codes.
# ADJUVANT / BROADRANGE / NEEMEXTRACT / PHT are descriptions; UNE and N-UNE mean
# unclassified; U and 111 are toxicity values that leaked across columns.
#
# NOTE: "11" is deliberately NOT here. FRAC 11 (QoI / strobilurins) is a real
# and common group in this book — azoxystrobin, famoxadone, trifloxystrobin.
# Only the three-digit "111" is the mangled Roman numeral.
_JUNK_CODES = {
    "ADJUVANT", "BROADRANGE", "NEEMEXTRACT", "PHT", "BIOLOGICAL",
    "UNE", "NUNE", "U", "111", "NA", "NONE", "",
}

_FORMULATIONS = (
    "ec", "wg", "wp", "sc", "sl", "wdg", "sp", "od", "ew", "cs", "me",
    "gr", "dc", "se", "fs",
)


def norm_product(s) -> str:
    """Comparison key for a product name: no strength, no formulation suffix.

    Strength and formulation are often glued together in the item master
    ("MAINSPRING 200SC") but spaced in the book ("MAINSPRING 200 SC"). Split
    digit/letter runs first or the suffix strippers below, which are
    word-boundary anchored, never see them — that alone cost 8 matches.
    """
    s = re.sub(r"(\d)([A-Za-z])", r"\1 \2", str(s))
    s = re.sub(r"([A-Za-z])(\d)", r"\1 \2", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s.lower())
    s = re.sub(r"\b(%s)\b" % "|".join(_FORMULATIONS), " ", s)
    s = re.sub(r"\b\d+(\.\d+)?\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def split_actives(s) -> list[str]:
    """Individual active ingredients, lower-cased, concentrations removed."""
    if not s:
        return []
    out = []
    for part in re.split(r"\s*\+\s*", str(s).replace("%", " ")):
        part = re.sub(r"\d+(\.\d+)?\s*(g|kg|mg|ml|l)\s*/\s*(l|kg|ha|g)", "", part, flags=re.I)
        part = re.sub(r"\d+(\.\d+)?\s*w\s*/\s*[wv]", "", part, flags=re.I)
        part = re.sub(r"[\d.]+", "", part)
        part = re.sub(r"\b(g|kg|l|ml|w|v)\b", "", part, flags=re.I)
        part = re.sub(r"[^a-zA-Z\- ]", " ", part)
        part = re.sub(r"\s+", " ", part).strip().lower()
        part = part.replace("sulfur", "sulphur").replace("alluminium", "aluminium")
        part = re.sub(r"\b(hydrochloride|hydrochlride|hcl)\b", "", part).strip()
        if len(part) > 3:
            out.append(part)
    return out


def normalise_codes(s) -> list[str]:
    """FRAC/IRAC codes. A pre-mixed product yields one entry per group.

    Handles the `PRAC` typo, internal spaces (`M 03` -> `M3`) and leading zeros.
    """
    if not s:
        return []
    text = str(s).upper().replace("PRAC", "FRAC")
    text = re.sub(r"\b(FRAC|IRAC)\b", " ", text)
    out = []
    for part in re.split(r"\s*\+\s*", text):
        part = part.strip().replace(" ", "").replace("-", "").replace("/", "")
        if part in _JUNK_CODES:
            continue
        m = re.fullmatch(r"([A-Z]?)0*(\d+)([A-Z]?)", part)
        if m:
            out.append(f"{m.group(1)}{int(m.group(2))}{m.group(3)}")
    return out


def repair_toxicity(s):
    """WHO hazard class, or None when absent/unusable."""
    if s is None:
        return None
    key = str(s).strip().upper()
    if key in ("", "-", "N/A", "NA", "U"):
        return None
    return TOXICITY_REPAIR.get(key)


def parse_rate(s):
    """(low, high) from a rate cell. A single value fills both."""
    if not s:
        return (None, None)
    nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", str(s))]
    if not nums:
        return (None, None)
    if len(nums) == 1:
        return (nums[0], nums[0])
    return (min(nums[:2]), max(nums[:2]))


def _is_section_header(col_a, rest) -> bool:
    return bool(col_a) and not rest and not col_a.replace(".", "").isdigit()


def parse_workbook(path: str = DEFAULT_WORKBOOK) -> list[dict]:
    """One dict per product row, in workbook order."""
    wb = openpyxl.load_workbook(path, data_only=True)
    rows = []
    for ws in wb.worksheets:
        is_mona = ws.title == MONA_SHEET
        code_col, form_col, rate_col, tox_col = _COLS[is_mona]
        section = None
        for r in ws.iter_rows(min_row=3, values_only=True):
            col_a = str(r[0]).strip() if r[0] is not None else ""
            rest = [v for v in r[1:] if v not in (None, "")]
            if _is_section_header(col_a, rest):
                section = col_a
                continue
            if not section or not r[1]:
                continue
            # Sheet2 supplies targets only — never a rate, never a toxicity.
            low, high = parse_rate(r[rate_col]) if is_mona else (None, None)
            rows.append({
                "sheet": ws.title,
                "product": str(r[1]).strip(),
                "key": norm_product(r[1]),
                "section": section,
                "targets": TARGET_ALIASES.get(section.lower().strip(), []),
                "actives": split_actives(r[4]),
                "codes": normalise_codes(r[code_col]),
                "toxicity": repair_toxicity(r[tox_col]) if is_mona else None,
                "rate_low": low,
                "rate_high": high,
                "formulation": str(r[form_col] or "").strip() or None,
                "registration_no": re.sub(r"[^0-9]", "", str(r[2] or "")) or None,
            })
    return rows


def active_target_map(rows) -> dict[str, set]:
    """active ingredient -> every target any product containing it treats.

    This is what recovers multi-target activity. Each sheet files a product
    under exactly one heading, so matching on product name alone yields no
    multi-target products at all; the actives restore what the layout hides
    (azoxystrobin treats Botrytis, Downy and Powdery Mildew).
    """
    out: dict[str, set] = {}
    for r in rows:
        for a in r["actives"]:
            out.setdefault(a, set()).update(r["targets"])
    return out
