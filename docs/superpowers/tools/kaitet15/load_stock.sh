#!/usr/bin/env bash
# The three stock tables are 2.5 / 1.8 / 1.9 GB of dump text, so they cannot
# share a staging pass on this disk. One table per pass: stage it, keep the
# July window, drop the stage, check disk, move on.
set -euo pipefail

SP="$(cd "$(dirname "$0")" && pwd)"
BENCH=/home/ubuntu/stive/code/frappe15lts
SITE="$BENCH/sites/kaitet15.local"
PY="$BENCH/env/bin/python"
DB=$(python3 -c "import json;print(json.load(open('$SITE/site_config.json'))['db_name'])")
PASS=$(python3 -c "import json;print(json.load(open('$SITE/site_config.json'))['db_password'])")
EMPTY="$SP/_empty.txt"; : > "$EMPTY"

pass() {                       # pass <table> <where>
  local table="$1" where="$2"
  local avail
  avail=$(df --output=avail -BG /home/ubuntu | tail -1 | tr -dc '0-9')
  echo
  echo "### $table  (free: ${avail}G)"
  if [ "$avail" -lt 3 ]; then
    echo "!! under 3G free — stopping before staging $table"
    return 1
  fi
  printf '%s\n' "$table" > "$SP/_one.txt"
  time bash "$SP/stream_load.sh" "$EMPTY" "$SP/_one.txt" "$DB" "$DB" "$PASS"
  $PY "$SP/merge_stage.py" "$SITE" "$table" --where "$where"
  df -h /home/ubuntu | tail -1
}

pass "tabStock Entry"        "posting_date >= '2026-07-01'"
pass "tabStock Entry Detail" "EXISTS (SELECT 1 FROM \`tabStock Entry\` p WHERE p.name = parent)"
pass "tabStock Ledger Entry" "posting_date >= '2026-07-01'"

echo
echo "### stock done"
