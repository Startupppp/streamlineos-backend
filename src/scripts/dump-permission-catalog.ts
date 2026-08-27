/**
 * Prints the real backend permission catalog as JSON, one line, for the .mjs
 * checks that cannot import TypeScript.
 *
 * Greping `name: "..."` out of the catalog folder misses every generated key:
 * `<module>:access:view` and `<module>:access:manage` are built from
 * `delegableModuleIds()` as template literals (`permissions/module-access.ts:14`),
 * so a text scan reports twelve real keys as absent and any check built on it
 * fails on correct code. Loading the module is the only exact answer.
 */
import {
  ACCESS_MANAGED_MODULES,
  PERMISSIONS,
  isScopable,
} from "../modules/rbac/permissions";

process.stdout.write(
  JSON.stringify({
    names: PERMISSIONS.map((permission) => permission.name),
    scopable: PERMISSIONS.map((permission) => permission.name).filter(isScopable),
    // The modules whose access screen is authorized by assertModuleAccessPolicy
    // rather than by @RequirePermission. Emitted from the same list the keys are
    // generated from, so a check never has to hand-maintain the exception set.
    accessManaged: [...ACCESS_MANAGED_MODULES],
  }),
);
