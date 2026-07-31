#!/usr/bin/env bash
# Sample by CONTENT, not position: emit only the INSERT statements of a table
# whose text matches a keyword. mysqldump packs ~1 MB of rows per statement, so
# a handful of matches is a few MB and is guaranteed to contain the pattern.
#   stream_grep.sh <table> <regex> <max_matches> <db> <user> <pass> <suffix>
set -euo pipefail
TABLE="$1"; RE="$2"; MAXM="$3"; DB="$4"; DBUSER="$5"; DBPASS="$6"; SUF="$7"
DUMP="${DUMP:-/home/ubuntu/stive/code/frappe15/20260713_234519-stream-database.sql.gz}"
{
  echo "SET sql_mode='NO_ENGINE_SUBSTITUTION'; SET foreign_key_checks=0; SET unique_checks=0;"
  zcat "$DUMP" | awk -v want="$TABLE" -v re="$RE" -v maxm="$MAXM" -v suf="$SUF" '
    /^-- Table structure for table `/ {
      match($0,/`[^`]+`/); cur=substr($0,RSTART+1,RLENGTH-2); emit=(cur==want)?1:0; n=0; next }
    emit {
      if ($0 ~ /^INSERT INTO /) { if (n >= maxm || $0 !~ re) next; n++ }
      if ($0 ~ /^(DROP TABLE|CREATE TABLE|LOCK TABLES|INSERT INTO|UNLOCK TABLES|\/\*!40000 ALTER TABLE)/)
        sub("`" cur "`", "`" suf cur "`")
      print
    }'
  echo "SET foreign_key_checks=1; SET unique_checks=1;"
} | mysql --default-character-set=utf8mb4 -u"$DBUSER" -p"$DBPASS" "$DB"
