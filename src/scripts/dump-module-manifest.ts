import {
  MODULE_MANIFEST_VERSION,
  MODULE_REGISTRY,
  storedModuleKey,
} from "../common/rbac/module-registry";

process.stdout.write(
  JSON.stringify({
    version: MODULE_MANIFEST_VERSION,
    modules: MODULE_REGISTRY.map((entry) => ({
      id: entry.id,
      route: entry.route,
      productKey: entry.productKey,
      moduleFolder: entry.moduleFolder,
      schemaFolder: entry.schemaFolder,
      publicExposure: entry.publicExposure,
      cacheNamespaces: [...entry.cacheNamespaces],
      planGated: entry.planGated,
      ladder: entry.ladder,
      administrable: entry.administrable,
      administersNamespaces: [...entry.administersNamespaces],
      storedKey: storedModuleKey(entry.id),
    })),
  }),
);
