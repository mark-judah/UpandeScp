#!/usr/bin/env bash
# Mirror the asset family + accounting docs into kaitet.local (v16).
# v16 schema != the v15 dump, so every table is STAGED and merged by column
# intersection with INSERT IGNORE — never dropped and recreated from v15 DDL.
set -euo pipefail
SP="$(cd "$(dirname "$0")" && pwd)"
BENCH=/home/ubuntu/stive/code/frappe15
SITE="$BENCH/sites/kaitet.local"
PY="$BENCH/env/bin/python"
DB=$(python3 -c "import json;print(json.load(open('$SITE/site_config.json'))['db_name'])")
PASS=$(python3 -c "import json;print(json.load(open('$SITE/site_config.json'))['db_password'])")
: > "$SP/_empty.txt"

echo "### staging $(wc -l < "$SP/asset_tables_v16.txt") tables out of the dump"
time bash "$SP/stream_load.sh" "$SP/_empty.txt" "$SP/asset_tables_v16.txt" "$DB" "$DB" "$PASS"

echo
echo "### merging (INSERT IGNORE, column intersection)"
while read -r t; do
  [ -z "$t" ] && continue
  $PY "$SP/merge_stage.py" "$SITE" "$t" || echo "  !! failed: $t"
done < "$SP/asset_tables_v16.txt"
df -h /home/ubuntu | tail -1
