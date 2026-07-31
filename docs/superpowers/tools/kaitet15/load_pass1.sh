#!/usr/bin/env bash
# Pass 1: the 103 full tables + the 9 scouting tables staged for a July window,
# plus the 9 selective tables (user/roles/singles/custom fields) staged for a
# merge that must not clobber the fresh site's own rows.
set -euo pipefail

SP="$(cd "$(dirname "$0")" && pwd)"
BENCH=/home/ubuntu/stive/code/frappe15lts
SITE="$BENCH/sites/kaitet15.local"
PY="$BENCH/env/bin/python"
DB=$(python3 -c "import json;print(json.load(open('$SITE/site_config.json'))['db_name'])")
PASS=$(python3 -c "import json;print(json.load(open('$SITE/site_config.json'))['db_password'])")

cat "$SP/stage_scouting.txt" "$SP/stage_selective.txt" > "$SP/_stage_all.txt"

echo "### streaming full + staged tables out of the dump (one pass)"
time bash "$SP/stream_load.sh" "$SP/full_tables.txt" "$SP/_stage_all.txt" "$DB" "$DB" "$PASS"

echo
echo "### merging the July scouting window (parent first)"
JULY="date_of_capture >= '2026-07-01'"
$PY "$SP/merge_stage.py" "$SITE" "tabScouting Entry" --where "$JULY"

CHILD_WHERE="EXISTS (SELECT 1 FROM \`tabScouting Entry\` p WHERE p.name = parent)"
for t in "tabPests Scouting Entry" "tabDiseases Scouting Entry" "tabWeeds Scouting Entry" \
         "tabTrap Scouting Entry" "tabIncidents Scouting Entry" "tabPredators Scouting Entry" \
         "tabPhysiological Disorders Entry"; do
  $PY "$SP/merge_stage.py" "$SITE" "$t" --where "$CHILD_WHERE"
done
$PY "$SP/merge_stage.py" "$SITE" "tabScouting Entry Metadata" \
    --where "EXISTS (SELECT 1 FROM \`tabScouting Entry\` p WHERE p.name = scouting_entry)"

echo
echo "### merging users/roles/permissions (INSERT IGNORE: site rows win)"
for t in "tabUser" "tabRole" "tabHas Role" "tabUser Permission" "tabDefaultValue"; do
  $PY "$SP/merge_stage.py" "$SITE" "$t"
done

echo
echo "### naming series (production counters win, so numbering continues)"
$PY "$SP/merge_stage.py" "$SITE" "tabSeries" --replace

echo
echo "### singles + custom fields, restricted to doctypes this site actually has"
$PY "$SP/merge_stage.py" "$SITE" "tabSingles" \
    --where "doctype IN (SELECT name FROM \`tabDocType\`)"
for t in "tabCustom Field" "tabProperty Setter"; do
  $PY "$SP/merge_stage.py" "$SITE" "$t" --where "dt IN (SELECT name FROM \`tabDocType\`)"
done

echo
echo "### done"
df -h /home/ubuntu | tail -1
