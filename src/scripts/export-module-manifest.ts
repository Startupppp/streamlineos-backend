import { writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { MODULE_MANIFEST_VERSION, MODULE_REGISTRY } from "../common/rbac/module-registry";

const outPath =
  process.argv[2] ?? resolve(__dirname, "../../module-manifest.json");

const sortedModules = [...MODULE_REGISTRY]
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((entry) => {
    const raw: Record<string, unknown> = {
      administrable: entry.administrable,
      administersNamespaces: [...entry.administersNamespaces],
      cacheNamespaces: [...entry.cacheNamespaces],
      displayName: entry.displayName,
      id: entry.id,
      ladder: entry.ladder,
      moduleFolder: entry.moduleFolder,
      planGated: entry.planGated,
      productKey: entry.productKey,
      publicExposure: entry.publicExposure,
      route: entry.route,
      schemaFolder: entry.schemaFolder,
    };
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(raw).sort()) {
      sorted[key] = raw[key];
    }
    return sorted;
  });

const document: Record<string, unknown> = {
  modules: sortedModules,
  version: MODULE_MANIFEST_VERSION,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n", "utf8");
process.stderr.write(`wrote ${outPath}\n`);
