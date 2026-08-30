import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MODULE_MANIFEST_VERSION, MODULE_REGISTRY } from "./module-registry";

const RBAC_DIR = join(__dirname);
const MODULES_BASE = join(__dirname, "../../modules");
const SCHEMA_BASE = join(__dirname, "../../db/schema");
/**
 * The frontend checkout, wherever it sits beside this one.
 *
 * The path here was `<monorepo>/frontend/...`, which is not where the frontend
 * is — it lives under `streamlineos-frontend/frontend/` — so this read threw
 * ENOENT and took the whole suite with it rather than checking anything. Both
 * layouts are tried, and "readable and non-empty" below is what fails, loudly,
 * when neither is present.
 */
const FRONTEND_NAV_TYPES =
  [
    "../../../../streamlineos-frontend/frontend/components/layout/sidebar/sidebar-nav-types.ts",
    "../../../../frontend/components/layout/sidebar/sidebar-nav-types.ts",
  ]
    .map((candidate) => join(__dirname, candidate))
    .find(existsSync) ?? "";

function parseProductKeyUnion(source: string): Set<string> {
  const match = source.match(/type\s+ProductKey\s*=([^;]+)/s);
  if (!match) return new Set();
  const keys: string[] = [];
  for (const m of match[1].matchAll(/"([^"]+)"/g)) keys.push(m[1]);
  return new Set(keys);
}

describe("MODULE_MANIFEST_VERSION", () => {
  it("is a positive integer", () => {
    expect(typeof MODULE_MANIFEST_VERSION).toBe("number");
    expect(MODULE_MANIFEST_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(MODULE_MANIFEST_VERSION)).toBe(true);
  });
});

describe("every registry entry carries every new field with the correct runtime type", () => {
  for (const entry of MODULE_REGISTRY) {
    const { id } = entry;
    it(`module "${id}" — route is string | null starting with /`, () => {
      expect(entry.route === null || typeof entry.route === "string").toBe(true);
      if (typeof entry.route === "string") expect(entry.route.startsWith("/")).toBe(true);
    });

    it(`module "${id}" — productKey is string | null`, () => {
      expect(entry.productKey === null || typeof entry.productKey === "string").toBe(true);
    });

    it(`module "${id}" — moduleFolder is string | null`, () => {
      expect(entry.moduleFolder === null || typeof entry.moduleFolder === "string").toBe(true);
    });

    it(`module "${id}" — schemaFolder is string | null`, () => {
      expect(entry.schemaFolder === null || typeof entry.schemaFolder === "string").toBe(true);
    });

    it(`module "${id}" — publicExposure is boolean`, () => {
      expect(typeof entry.publicExposure).toBe("boolean");
    });

    it(`module "${id}" — cacheNamespaces is readonly string[]`, () => {
      expect(Array.isArray(entry.cacheNamespaces)).toBe(true);
      for (const ns of entry.cacheNamespaces) expect(typeof ns).toBe("string");
    });
  }
});

describe("moduleFolder paths exist on disk", () => {
  for (const entry of MODULE_REGISTRY) {
    const mf = entry.moduleFolder;
    if (mf === null) continue;
    it(`module "${entry.id}" moduleFolder "${mf}" exists under src/modules/`, () => {
      expect(existsSync(join(MODULES_BASE, mf))).toBe(true);
    });
  }
});

describe("schemaFolder paths exist on disk", () => {
  for (const entry of MODULE_REGISTRY) {
    const sf = entry.schemaFolder;
    if (sf === null) continue;
    it(`module "${entry.id}" schemaFolder "${sf}" exists under src/db/schema/`, () => {
      expect(existsSync(join(SCHEMA_BASE, sf))).toBe(true);
    });
  }
});

describe("productKey values are in the frontend ProductKey union", () => {
  let frontendProductKeys: Set<string> = new Set();

  beforeAll(() => {
    frontendProductKeys = FRONTEND_NAV_TYPES
      ? parseProductKeyUnion(readFileSync(FRONTEND_NAV_TYPES, "utf8"))
      : new Set();
  });

  it("the frontend ProductKey union is readable and non-empty", () => {
    expect(frontendProductKeys.size).toBeGreaterThan(0);
  });

  for (const entry of MODULE_REGISTRY) {
    const pk = entry.productKey;
    if (pk === null) continue;
    it(`module "${entry.id}" productKey "${pk}" is in the frontend ProductKey union`, () => {
      expect(frontendProductKeys.has(pk)).toBe(true);
    });
  }
});

describe("cross-entry uniqueness", () => {
  it("productKey values are unique across all entries (null excluded)", () => {
    type ProductKeyField = (typeof MODULE_REGISTRY)[number]["productKey"];
    const nonNull = MODULE_REGISTRY.map((e) => e.productKey).filter(
      (k): k is NonNullable<ProductKeyField> => k !== null,
    );
    expect(new Set(nonNull).size).toBe(nonNull.length);
  });

  it("route values are unique across all entries (null excluded)", () => {
    type RouteField = (typeof MODULE_REGISTRY)[number]["route"];
    const nonNull = MODULE_REGISTRY.map((e) => e.route).filter(
      (r): r is NonNullable<RouteField> => r !== null,
    );
    expect(new Set(nonNull).size).toBe(nonNull.length);
  });
});

describe("no second registration site in src/common/rbac/", () => {
  it("no non-spec .ts file besides module-registry.ts hardcodes a module-id array", () => {
    const files = readdirSync(RBAC_DIR).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".spec.ts") && f !== "module-registry.ts",
    );
    const ids = new Set(MODULE_REGISTRY.map((e) => e.id));
    for (const file of files) {
      const src = readFileSync(join(RBAC_DIR, file), "utf8");
      const found = [...ids].filter((id) => new RegExp(`"${id}"`).test(src));
      expect(found.length).toBeLessThan(3);
    }
  });
});
