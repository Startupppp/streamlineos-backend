// The real catalog as JSON: greping it misses the generated `<module>:access:*` keys.
import {
  ACCESS_MANAGED_MODULES,
  PERMISSIONS,
  isScopable,
} from "../modules/rbac/permissions";

process.stdout.write(
  JSON.stringify({
    names: PERMISSIONS.map((permission) => permission.name),
    scopable: PERMISSIONS.map((permission) => permission.name).filter(isScopable),
    // Emitted from the list the keys are generated from, so no check hand-maintains it.
    accessManaged: [...ACCESS_MANAGED_MODULES],
  }),
);
