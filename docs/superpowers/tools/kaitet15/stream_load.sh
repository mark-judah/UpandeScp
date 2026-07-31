#!/usr/bin/env bash
# Stream selected tables out of the v15 production dump straight into a database.
# Never decompresses the whole file, never writes a temp copy.
#
#   stream_load.sh <full-list-file> <stage-list-file> <db> <dbuser> <dbpass>
#
# full-list-file  : one table name per line (e.g. "tabItem") -> restored as-is
# stage-list-file : one table name per line -> restored as "_stage_<name>" so the
#                   caller can INSERT..SELECT a row window out of it, then drop it.
set -euo pipefail

FULL_LIST="$1"; STAGE_LIST="$2"; DB="$3"; DBUSER="$4"; DBPASS="$5"
DUMP="${DUMP:-/home/ubuntu/stive/code/frappe15/20260713_234519-stream-database.sql.gz}"

{
  # Our own preamble: the dump's header is skipped by the section filter below.
  echo "SET sql_mode='NO_ENGINE_SUBSTITUTION';"
  echo "SET foreign_key_checks=0;"
  echo "SET unique_checks=0;"
  echo "SET autocommit=1;"

  zcat "$DUMP" | awk -v fullf="$FULL_LIST" -v stagef="$STAGE_LIST" '
    BEGIN {
      while ((getline line < fullf)  > 0) if (line != "") full[line]  = 1
      while ((getline line < stagef) > 0) if (line != "") stage[line] = 1
      emit = 0
    }
    /^-- Table structure for table `/ {
      match($0, /`[^`]+`/)
      cur = substr($0, RSTART+1, RLENGTH-2)
      if (cur in full)       { emit = 1; rewrite = 0 }
      else if (cur in stage) { emit = 1; rewrite = 1 }
      else                   { emit = 0; rewrite = 0 }
      next
    }
    emit {
      if (rewrite && $0 ~ /^(DROP TABLE|CREATE TABLE|LOCK TABLES|INSERT INTO|UNLOCK TABLES|\/\*!40000 ALTER TABLE)/) {
        # rewrite only the first backticked identifier on structural lines, so
        # row data that happens to contain the table name is never touched
        sub("`" cur "`", "`_stage_" cur "`")
      }
      print
    }
  '

  echo "SET foreign_key_checks=1;"
  echo "SET unique_checks=1;"
} | mysql --default-character-set=utf8mb4 -u"$DBUSER" -p"$DBPASS" "$DB"
