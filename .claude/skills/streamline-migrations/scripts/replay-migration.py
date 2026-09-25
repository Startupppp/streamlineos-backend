#!/usr/bin/env python3
"""
Emit SQL that applies one or more migrations inside a transaction it then rolls
back, so their constraints can be fired at with real INSERTs.

    python3 replay-migration.py 1187_rejection_reason 1188_offer_comp > /tmp/r.sql
    psql -d streamline_test -v ON_ERROR_STOP=0 -f /tmp/r.sql

Why a rolled-back transaction rather than a scratch database: it runs against
the real table definitions, so a constraint that conflicts with an existing one
fails here the way it would in production, and nothing is left behind.

Why `session_replication_role = replica`: it disables FK triggers so a bare row
can be inserted without building its whole parent graph. CHECK constraints are
not triggers and still fire — which is the entire point. It needs superuser,
which local dev databases have and Neon does not; this is a local-only tool.

Append your own cases with --case; each runs inside a SAVEPOINT that is rolled
back, so they cannot affect one another. State the expectation in the label —
a case whose expected result you did not write down is a case you will
misread.
"""
import argparse
import pathlib
import sys

BREAK = "--> statement-breakpoint"


def statements(path: pathlib.Path):
    for chunk in path.read_text().split(BREAK):
        s = chunk.strip()
        if s:
            yield s if s.endswith(";") else s + ";"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("tags", nargs="+", help="migration tags, e.g. 1187_rejection_reason")
    ap.add_argument("--migrations-dir", default="migrations")
    ap.add_argument(
        "--case",
        action="append",
        default=[],
        metavar="LABEL::SQL",
        help="a probe run in its own rolled-back SAVEPOINT; label says what you expect",
    )
    ap.add_argument(
        "--keep-fks",
        action="store_true",
        help="do not disable FK triggers (you are inserting a full parent graph)",
    )
    args = ap.parse_args()

    out = ["BEGIN;"]
    if not args.keep_fks:
        out.append("SET session_replication_role = replica;")

    root = pathlib.Path(args.migrations_dir)
    for tag in args.tags:
        path = root / f"{tag}.sql"
        if not path.exists():
            print(f"no such migration: {path}", file=sys.stderr)
            return 2
        out.append(f"\\echo ===== applying {tag} =====")
        out.extend(statements(path))

    for case in args.case:
        label, _, sql = case.partition("::")
        if not sql:
            print(f"--case needs LABEL::SQL, got: {case}", file=sys.stderr)
            return 2
        out += ["\\echo ", f"\\echo --- {label}", "SAVEPOINT probe;",
                sql if sql.rstrip().endswith(";") else sql + ";",
                "ROLLBACK TO probe;"]

    # Read back what landed, rather than trusting the DDL you just sent.
    out += [
        "\\echo ", "\\echo ===== what actually landed =====",
        "SELECT conname, contype, convalidated, pg_get_constraintdef(oid) AS def "
        "FROM pg_constraint WHERE conrelid IN (SELECT oid FROM pg_class WHERE relkind='r') "
        "AND conname LIKE 'chk_%' ORDER BY conname DESC LIMIT 12;",
        "ROLLBACK;",
    ]
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
