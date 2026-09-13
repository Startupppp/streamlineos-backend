import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { topologicalOrder, requireSafeTarget } from "../cell-backup-utils.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cell-backup.mjs");

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`PASS  ${name}\n`);
  } catch (e) {
    process.stderr.write(`FAIL  ${name}\n`);
    process.stderr.write(`      ${e.message}\n`);
    process.exitCode = 1;
  }
}

function spawn(args, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { PATH: process.env.PATH, ...extraEnv },
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 10000,
  });
}

test("topologicalOrder places parents before their children", () => {
  const tables = [
    { schema: "public", table: "child" },
    { schema: "public", table: "parent" },
  ];
  const edges = [
    { child_schema: "public", child: "child", parent_schema: "public", parent: "parent", deferrable: false },
  ];
  const { ordered, cyclic } = topologicalOrder(tables, edges);
  const names = ordered.map((t) => t.table);
  assert.ok(names.indexOf("parent") < names.indexOf("child"), `parent must precede child; got ${names.join(" -> ")}`);
  assert.equal(cyclic.length, 0, "no cyclic tables expected");
});

test("topologicalOrder reports mutual cycles rather than silently ordering them", () => {
  const tables = [
    { schema: "public", table: "loop_a" },
    { schema: "public", table: "loop_b" },
  ];
  const edges = [
    { child_schema: "public", child: "loop_a", parent_schema: "public", parent: "loop_b", deferrable: false },
    { child_schema: "public", child: "loop_b", parent_schema: "public", parent: "loop_a", deferrable: false },
  ];
  const { ordered, cyclic } = topologicalOrder(tables, edges);
  assert.equal(ordered.length, 0, "nothing should be ordered when all tables are cyclic");
  assert.equal(cyclic.length, 2, "both tables must appear in the cyclic set");
});

test("topologicalOrder skips deferrable FK edges so they do not constrain order", () => {
  const tables = [
    { schema: "public", table: "a" },
    { schema: "public", table: "b" },
  ];
  const edges = [
    { child_schema: "public", child: "a", parent_schema: "public", parent: "b", deferrable: true },
    { child_schema: "public", child: "b", parent_schema: "public", parent: "a", deferrable: true },
  ];
  const { ordered, cyclic } = topologicalOrder(tables, edges);
  assert.equal(cyclic.length, 0, "deferrable cycle must not be reported as cyclic");
  assert.equal(ordered.length, 2);
});

test("requireSafeTarget passes for localhost", () => {
  const local = { cell: { ownerDirect: "postgresql://u:p@localhost:5432/scratch_x", app: "postgresql://u:p@127.0.0.1:5432/scratch_x" } };
  assert.doesNotThrow(() => requireSafeTarget(local));
});

test("requireSafeTarget passes for 127.0.0.1", () => {
  const local = { cell: { ownerDirect: "postgresql://u:p@127.0.0.1:5432/scratch_x", app: "postgresql://u:p@127.0.0.1:5432/scratch_x" } };
  assert.doesNotThrow(() => requireSafeTarget(local));
});

test("requireSafeTarget refuses a Neon remote host", () => {
  const neon = { cell: { ownerDirect: "postgresql://u:p@ep-xxx.us-east-2.aws.neon.tech/neondb", app: "postgresql://u:p@ep-xxx.us-east-2.aws.neon.tech/neondb" } };
  assert.throws(() => requireSafeTarget(neon), /Unsafe target/);
});

test("requireSafeTarget refuses any non-local hostname", () => {
  const remote = { cell: { ownerDirect: "postgresql://u:p@db.example.com/mydb", app: "postgresql://u:p@db.example.com/mydb" } };
  assert.throws(() => requireSafeTarget(remote), /Unsafe target/);
});

test("--self-test exits 0 with no DATABASE_URL in env (fully isolated)", () => {
  const r = spawn(["--self-test"]);
  assert.equal(r.status, 0, `Expected exit 0, got ${r.status}. stderr: ${r.stderr.trim()}`);
  assert.ok(r.stdout.includes("SELF-TEST PASS"), `Expected SELF-TEST PASS in stdout: ${r.stdout.trim()}`);
});

test("--self-test does not load production env — it never touches cell topology", () => {
  const r = spawn(["--self-test"]);
  const combined = r.stdout + r.stderr;
  assert.ok(!combined.includes("parseCellArgs"), "parseCellArgs must not appear in self-test output");
  assert.ok(!combined.includes("DATABASE_URL"), "DATABASE_URL must not appear in self-test output");
  assert.equal(r.status, 0);
});

test("real execution refuses when DATABASE_URL is missing", () => {
  const r = spawn(["--backup", "--region=cell-2"]);
  assert.notEqual(r.status, 0, "must exit non-zero when DATABASE_URL is absent");
  const combined = r.stdout + r.stderr;
  assert.ok(
    combined.includes("DATABASE_URL"),
    `Expected DATABASE_URL error message, got: ${combined.trim()}`,
  );
});

test("real execution refuses a remote-looking Neon URL", () => {
  const neonUrl = "postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb";
  const r = spawn(["--backup", "--region=cell-2"], {
    DATABASE_URL: neonUrl,
    APP_DATABASE_URL: neonUrl,
  });
  assert.notEqual(r.status, 0, "must exit non-zero for a Neon/remote target");
  const combined = r.stdout + r.stderr;
  assert.ok(
    combined.includes("Unsafe target"),
    `Expected "Unsafe target" in output, got: ${combined.trim()}`,
  );
});

test("real execution refuses any non-localhost hostname", () => {
  const remoteUrl = "postgresql://user:pass@db.example.com/mydb";
  const r = spawn(["--backup", "--region=cell-2"], {
    DATABASE_URL: remoteUrl,
    APP_DATABASE_URL: remoteUrl,
  });
  assert.notEqual(r.status, 0, "must exit non-zero for a remote hostname");
  const combined = r.stdout + r.stderr;
  assert.ok(
    combined.includes("Unsafe target"),
    `Expected "Unsafe target" in output, got: ${combined.trim()}`,
  );
});

if (process.exitCode !== 1)
  process.stdout.write("\nAll cell-backup prerequisite-guard tests passed.\n");
