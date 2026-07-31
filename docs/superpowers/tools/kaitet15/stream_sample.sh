#!/usr/bin/env bash
# Take a SAMPLE of tables that are too big to stage whole: emit the DDL plus at
# most MAX_INSERTS extended-INSERT statements per table, renamed to _ref_tabX.
#
#   stream_sample.sh <table-list> <db> <user> <pass> [max_inserts]
#
# mysqldump writes one extended INSERT per ~1 MB, so 4 statements is a few
# thousand real rows — enough to see the document shape and the range of
# stock_entry_type values without staging 2.9 GB.
set -euo pipefail

LIST="$1"; DB="$2"; DBUSER="$3"; DBPASS="$4"; MAX="${5:-4}"
DUMP="${DUMP:-/home/ubuntu/stive/code/frappe15/20260713_234519-stream-database.sql.gz}"

{
  echo "SET sql_mode='NO_ENGINE_SUBSTITUTION';"
  echo "SET foreign_key_checks=0;"
  echo "SET unique_checks=0;"

  zcat "$DUMP" | awk -v listf="$LIST" -v maxins="$MAX" '
    BEGIN { while ((getline l < listf) > 0) if (l != "") want[l] = 1; emit = 0 }
    /^-- Table structure for table `/ {
      match($0, /`[^`]+`/); cur = substr($0, RSTART+1, RLENGTH-2)
      emit = (cur in want) ? 1 : 0; n = 0
      next
    }
    emit {
      if ($0 ~ /^INSERT INTO /) {
        if (n >= maxins) next          # keep only the first maxins statements
        n++
      }
      if ($0 ~ /^(DROP TABLE|CREATE TABLE|LOCK TABLES|INSERT INTO|UNLOCK TABLES|\/\*!40000 ALTER TABLE)/)
        sub("`" cur "`", "`_ref_" cur "`")
      print
    }
  '

  echo "SET foreign_key_checks=1;"
  echo "SET unique_checks=1;"
} | mysql --default-character-set=utf8mb4 -u"$DBUSER" -p"$DBPASS" "$DB"
