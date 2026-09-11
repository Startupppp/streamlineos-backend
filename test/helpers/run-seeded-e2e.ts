import { spawnSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { buildSeededProcessEnvironment, assertSeededProcessIsolation } from "./seeded-process-environment";
import { verifySeededDatabaseHead } from "./seeded-database-preflight";

const [database, ...files] = process.argv.slice(2);
if (!database || files.length === 0)
  throw new Error("Usage: node --env-file-if-exists=.env -r ts-node/register/transpile-only test/helpers/run-seeded-e2e.ts scratch_e2e test/<module>/<name>.seeded-e2e-spec.ts");
const root = resolve(__dirname, "../..");
for (const file of files) {
  const local = relative(root, resolve(root, file)).replaceAll("\\", "/");
  const harnessSelfTest = local === "test/helpers/__tests__/seeded-e2e-app.spec.ts";
  if (!local.startsWith("test/") || (!local.endsWith(".seeded-e2e-spec.ts") && !harnessSelfTest) || /(^|\/)(crm|inventory)(\/|$)/i.test(local))
    throw new Error("[seeded-e2e] select explicit in-scope seeded spec files under test/");
}
const env = buildSeededProcessEnvironment(process.env, database);
assertSeededProcessIsolation(env);
void verifySeededDatabaseHead(env, root).then(() => {
  const result = spawnSync(process.execPath, [
    "--expose-gc", "--max-old-space-size=8192", resolve(root, "node_modules/jest/bin/jest.js"),
    "--config", resolve(root, "jest-e2e-seeded.json"), "--runInBand", "--runTestsByPath", ...files,
  ], { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw new Error("[seeded-e2e] failed to launch isolated test process");
  process.exitCode = result.status ?? 1;
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "[seeded-e2e] preflight failed"}\n`);
  process.exitCode = 1;
});
