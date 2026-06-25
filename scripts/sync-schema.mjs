import { cpSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const WEB_SCHEMA = resolve(process.cwd(), "..", "Streamlineos", "lib", "db", "schema");
const DEST = resolve(process.cwd(), "src", "db", "schema");
const check = process.argv.includes("--check");

if (!existsSync(WEB_SCHEMA)) {
  console.error(`[sync-schema] web schema not found at ${WEB_SCHEMA}`);
  process.exit(1);
}

function listTsFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return listTsFiles(p, base);
    return e.name.endsWith(".ts") ? [p.slice(base.length + 1)] : [];
  });
}

if (check) {
  if (!existsSync(DEST)) {
    console.error("[sync-schema] dest missing; run `pnpm sync:schema`");
    process.exit(1);
  }
  const src = listTsFiles(WEB_SCHEMA).sort();
  const dst = listTsFiles(DEST).sort();
  let drift = JSON.stringify(src) !== JSON.stringify(dst);
  for (const f of src) {
    if (!drift && readFileSync(join(WEB_SCHEMA, f), "utf8") !== readFileSync(join(DEST, f), "utf8")) {
      drift = true;
    }
  }
  if (drift) {
    console.error("[sync-schema] DRIFT detected. Run `pnpm sync:schema` and commit.");
    process.exit(1);
  }
  console.log("[sync-schema] schema in sync.");
} else {
  rmSync(DEST, { recursive: true, force: true });
  cpSync(WEB_SCHEMA, DEST, {
    recursive: true,
    filter: (srcPath) => statSync(srcPath).isDirectory() || srcPath.endsWith(".ts"),
  });
  console.log(`[sync-schema] copied *.ts from ${WEB_SCHEMA} -> ${DEST}`);
}
