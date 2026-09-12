import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ALL_PERMISSION_NAMES } from "../../rbac/permissions";

/**
 * Every permission key a seeded inventory spec grants itself must exist.
 *
 * `role_permission_grants.permission_key` carries a foreign key to
 * `permissions.name`, so a spec whose fixture grants a key nobody ever added to
 * the catalogue does not fail on the assertion it was written for — it dies in
 * `SeedBuilder.build`, in `beforeAll`, with
 *
 *     insert or update on table "role_permission_grants" violates foreign key
 *     constraint "role_permission_grants_permission_key_permissions_name_fk"
 *
 * and every test in the file reports that same stack. It reads like a broken
 * harness or a dependency-injection failure, and the one thing it does not
 * mention is the permission key. Two of these were live when the whole of
 * `test/inventory` was first run end to end:
 *
 *   * `inventory:quality:hold` — raising a hold is `inventory:quality:inspect`
 *     (`holds.controller.ts:49`);
 *   * `inventory:handling-units:manage` — handling units are authorized as
 *     stock, `inventory:stock:read` and `inventory:stock:transfer`.
 *
 * Both read like the obvious name for the thing they gate, which is exactly why
 * a plausible-sounding key is worth catching statically. This costs no database
 * and runs in the unit suite, so it answers in milliseconds instead of after a
 * seventy-second seed.
 */

const SEEDED_SPEC_DIR = join(__dirname, "..", "..", "..", "..", "test", "inventory");

/** A quoted `module:resource:action` literal, at any of the arities in use. */
const KEY_LITERAL = /["']([a-z0-9-]+(?::[a-z0-9-]+){1,3})["']/g;

/**
 * Namespaces that are permission keys. A literal like `"inv_cycle_count"` or
 * `"2026-08-01"` is not one, and sweeping every colon-separated string would
 * make this test about string shapes rather than about permissions.
 */
const PERMISSION_NAMESPACES = new Set(
  ALL_PERMISSION_NAMES.map((name) => name.split(":")[0]),
);

function seededSpecFiles(): string[] {
  return readdirSync(SEEDED_SPEC_DIR)
    .filter((name) => name.endsWith(".seeded-e2e-spec.ts"))
    .map((name) => join(SEEDED_SPEC_DIR, name));
}

describe("seeded inventory specs grant real permission keys", () => {
  const files = seededSpecFiles();

  it("finds the seeded specs at all", () => {
    // A sweep that reads no files reports no phantom keys, which is
    // indistinguishable from every key being real.
    expect(files.length).toBeGreaterThan(40);
  });

  it("has a catalogue to check against", () => {
    expect(ALL_PERMISSION_NAMES.length).toBeGreaterThan(400);
  });

  it("names no permission key the catalogue does not have", () => {
    const known = new Set<string>(ALL_PERMISSION_NAMES);
    const phantoms: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(KEY_LITERAL)) {
        const key = match[1];
        if (key === undefined) continue;
        const namespace = key.split(":")[0];
        if (namespace === undefined || !PERMISSION_NAMESPACES.has(namespace)) continue;
        if (known.has(key)) continue;
        const entry = `${key} (in ${file.split("/").pop() ?? file})`;
        if (!phantoms.includes(entry)) phantoms.push(entry);
      }
    }

    expect(phantoms).toEqual([]);
  });
});
