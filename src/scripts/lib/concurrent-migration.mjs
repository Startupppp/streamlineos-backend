const CONCURRENT_INDEX_RE = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i;
const EXPLICIT_TXN_RE = /^[ \t]*(BEGIN|START[ \t]+TRANSACTION|COMMIT|ROLLBACK)[ \t]*;/im;

export function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

export function usesConcurrentIndex(sql) {
  return CONCURRENT_INDEX_RE.test(stripSqlComments(sql));
}

export function requiresAutocommit(sql) {
  const code = stripSqlComments(sql);
  return CONCURRENT_INDEX_RE.test(code) || EXPLICIT_TXN_RE.test(code);
}

const CASES = [
  ["CREATE INDEX CONCURRENTLY a ON t (c);", true, true],
  ["CREATE UNIQUE INDEX CONCURRENTLY a ON t (c);", true, true],
  ["-- CREATE INDEX CONCURRENTLY is why this file exists\nCREATE TABLE t (id int);", false, false],
  ["/* CREATE INDEX CONCURRENTLY */\nALTER TABLE t ADD COLUMN c text;", false, false],
  ["CREATE INDEX a ON t (c);", false, false],
  ["CREATE TABLE t (id int); -- see CREATE INDEX CONCURRENTLY notes", false, false],
  ["DROP INDEX CONCURRENTLY a;", false, false],
  ["BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;", false, true],
  ["-- BEGIN; a comment\nCREATE TABLE t (id int);", false, false],
];

export function selfTest() {
  let failed = 0;
  for (const [sql, expectConcurrent, expectAutocommit] of CASES) {
    const gotConcurrent = usesConcurrentIndex(sql);
    const gotAutocommit = requiresAutocommit(sql);
    if (gotConcurrent !== expectConcurrent || gotAutocommit !== expectAutocommit) {
      failed++;
      console.error(
        `FAIL  concurrent ${gotConcurrent}/${expectConcurrent} autocommit ${gotAutocommit}/${expectAutocommit} for: ${sql.slice(0, 60).replace(/\n/g, "\\n")}`,
      );
    }
  }
  if (failed > 0) {
    console.error(`concurrent-migration self-test: ${failed} of ${CASES.length} failed`);
    process.exit(1);
  }
  console.log(`concurrent-migration self-test: ${CASES.length} cases OK`);
}
