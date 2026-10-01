import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { MatrixRunner } from "./matrix-runner";
import type { AdapterKind, ExecutableCell } from "./matrix.types";
import { STANDINGS } from "./standings";
import { matrixWorld } from "./fixtures";
import { closeHttpHarnesses } from "./adapters/http-adapter";
import { accessCells } from "./cells/access-cells";
import { buildCells } from "./cells/build-cells";
import { runtimeCells } from "./cells/runtime-cells";
import { declaredCells } from "./cells/declared-cells";

jest.setTimeout(60_000);

const BACKEND_ROOT = resolve(__dirname, "../../..");
const ADAPTERS: readonly AdapterKind[] = ["http", "realtime", "job", "file", "service"];

const world = matrixWorld();
const runner = new MatrixRunner();

const plantedFailure: ExecutableCell = {
  kind: "executable",
  id: "planted-failure",
  standing: "org:member",
  resource: "module-access:build",
  action: "manage-access",
  tenant: "same",
  state: "normal",
  expected: "403",
  adapter: "service",
  because: "the gate self-test plants an allow where a refusal is expected",
  pairedWith: "module-access-manage-org-admin",
  run: async () => ({ outcome: "allow" }),
};

const executable: ExecutableCell[] = [
  ...accessCells(world),
  ...buildCells(world),
  ...runtimeCells(world),
  ...(process.env.RBAC_MATRIX_PLANT_FAILURE === "1" ? [plantedFailure] : []),
];
for (const cell of executable) runner.declare(cell);
for (const cell of declaredCells()) runner.declare(cell);

function suitesOnDisk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return suitesOnDisk(path);
    return /spec\.ts$/.test(name) ? [relative(BACKEND_ROOT, path).split("\\").join("/")] : [];
  });
}

afterAll(async () => {
  await closeHttpHarnesses();
  const ledger = runner.ledger();
  const target = process.env.RBAC_MATRIX_LEDGER_OUT;
  if (target !== undefined && target !== "") {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(ledger, null, 2)}\n`);
  }
  process.stdout.write(
    `\nRBAC Matrix Ledger: proven=${ledger.proven} failed=${ledger.failed} unrun=${ledger.unrun} total=${ledger.total}\n`,
  );
});

describe("RBAC verification matrix", () => {
  for (const cell of executable)
    it(`${cell.id}: ${cell.standing} ${cell.action} on ${cell.resource} in the ${cell.tenant} tenant (${cell.state}) is ${cell.expected} because ${cell.because}`, async () => {
      expect(await runner.execute(cell)).toEqual({ status: "proven", detail: null });
    });
});

describe("RBAC verification matrix shape", () => {
  it("pairs every refusal with an allowed cell on the same resource, action and adapter so no negative passes on a surface nothing can reach", () => {
    const unpaired = executable
      .filter((cell) => cell.expected !== "allow")
      .filter((cell) => {
        const pair = cell.pairedWith === undefined ? undefined : runner.find(cell.pairedWith);
        return (
          pair === undefined ||
          pair.kind !== "executable" ||
          pair.expected !== "allow" ||
          pair.resource !== cell.resource ||
          pair.action !== cell.action ||
          pair.adapter !== cell.adapter
        );
      })
      .map((cell) => cell.id);
    expect(unpaired).toEqual([]);
  });

  it("names a pair only on refusals so an allowed cell never masquerades as a negative", () => {
    expect(executable.filter((cell) => cell.expected === "allow" && cell.pairedWith !== undefined).map((cell) => cell.id)).toEqual([]);
  });

  it("covers the six BE-102 standings and the outsider, each with at least one refusal", () => {
    for (const standing of STANDINGS) {
      expect(executable.filter((cell) => cell.standing === standing).length).toBeGreaterThan(0);
      expect(executable.some((cell) => cell.standing === standing && cell.expected !== "allow")).toBe(true);
    }
  });

  it("drives every adapter with both an allowed and a refused cell", () => {
    for (const adapter of ADAPTERS) {
      expect(executable.some((cell) => cell.adapter === adapter && cell.expected === "allow")).toBe(true);
      expect(executable.some((cell) => cell.adapter === adapter && cell.expected !== "allow")).toBe(true);
    }
  });

  it("states every contract outcome at least once: allow, 403 in-tenant, 404 cross-tenant and 402 module gate", () => {
    for (const outcome of ["allow", "403", "404", "402"] as const)
      expect(executable.some((cell) => cell.expected === outcome)).toBe(true);
    expect(executable.filter((cell) => cell.tenant === "other").every((cell) => cell.expected === "404")).toBe(true);
  });

  it("registers every BOLA suite on disk as a declared cell so the ledger shows what this run did not execute", () => {
    const declared = new Set(declaredCells().map((cell) => cell.evidenceSuite));
    const onDisk = [
      ...suitesOnDisk(join(BACKEND_ROOT, "test/security/bola")),
      ...readdirSync(join(BACKEND_ROOT, "test/security"))
        .filter((name) => /^bola-.*spec\.ts$/.test(name))
        .map((name) => `test/security/${name}`),
    ];
    expect(onDisk.filter((suite) => !declared.has(suite))).toEqual([]);
    expect([...declared].filter((suite) => !existsSync(join(BACKEND_ROOT, suite)))).toEqual([]);
  });
});
