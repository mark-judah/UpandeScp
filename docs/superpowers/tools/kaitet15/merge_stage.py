#!/usr/bin/env python
"""Merge `_stage_tabX` (production's schema) into the site's `tabX`.

Production runs an older v15 point release than this bench, so the two schemas
can differ by whichever columns later patches added. Copying by column
intersection keeps the site's schema authoritative and lets `bench migrate`
default the new columns, exactly as the v16 restore had to do.

  merge_stage.py <site-dir> <table> [--where "sql"] [--replace] [--keep-stage]

Default is INSERT IGNORE, so rows the fresh site already owns (Administrator,
Guest, ERPNext defaults) are never clobbered.
"""
import json
import os
import sys

import pymysql


def main():
    args = sys.argv[1:]
    site_dir, table = args[0], args[1]
    where = None
    replace = "--replace" in args
    keep = "--keep-stage" in args
    if "--where" in args:
        where = args[args.index("--where") + 1]

    cfg = json.load(open(os.path.join(site_dir, "site_config.json")))
    conn = pymysql.connect(
        host="127.0.0.1", user=cfg["db_name"], password=cfg["db_password"],
        database=cfg["db_name"], charset="utf8mb4", autocommit=True,
    )
    cur = conn.cursor()
    stage = "_stage_" + table

    def cols(t):
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema=%s AND table_name=%s", (cfg["db_name"], t))
        return [r[0] for r in cur.fetchall()]

    real_cols, stage_cols = cols(table), cols(stage)
    if not stage_cols:
        print(f"  {table}: no stage table, skipped")
        return
    if not real_cols:
        print(f"  {table}: target table missing on the site, skipped")
        return

    common = [c for c in real_cols if c in stage_cols]
    dropped = [c for c in stage_cols if c not in real_cols]
    collist = ", ".join(f"`{c}`" for c in common)

    verb = "REPLACE" if replace else "INSERT IGNORE"
    sql = f"{verb} INTO `{table}` ({collist}) SELECT {collist} FROM `{stage}`"
    if where:
        sql += f" WHERE {where}"

    cur.execute("SET SQL_BIG_SELECTS=1")
    cur.execute("SET foreign_key_checks=0")
    cur.execute(sql)
    moved = cur.rowcount
    cur.execute(f"SELECT COUNT(*) FROM `{table}`")
    total = cur.fetchone()[0]
    if not keep:
        cur.execute(f"DROP TABLE `{stage}`")
    note = f" | dropped cols not on this site: {', '.join(dropped)}" if dropped else ""
    print(f"  {table}: +{moved} rows (table now {total}){note}")


if __name__ == "__main__":
    main()
