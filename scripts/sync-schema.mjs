import { cpSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const WEB_SCHEMA = resolve(process.cwd(), "..", "Streamlineos", "lib", "db", "schema");
const DEST = resolve(process.cwd(), "src", "db", "schema");
const check = process.argv.includes("--check");

if (!existsSync(WEB_SCHEMA)) {
  console.error(`[sync-schema] web schema not found at ${WEB_SCHEMA}`);
  process.exit(1);
}

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [p.slice(base.length + 1)];
  });
}

if (check) {
  if (!existsSync(DEST)) {
    console.error("[sync-schema] dest missing; run `pnpm sync:schema`");
    process.exit(1);
  }
  const src = listFiles(WEB_SCHEMA).sort();
  const dst = listFiles(DEST).sort();
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
  cpSync(WEB_SCHEMA, DEST, { recursive: true });
  console.log(`[sync-schema] copied ${WEB_SCHEMA} -> ${DEST}`);
}
