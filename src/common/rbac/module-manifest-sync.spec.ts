import { readFileSync } from "fs";
import { join } from "path";
import { MODULE_MANIFEST_VERSION, MODULE_REGISTRY } from "./module-registry";
import { frontendPath } from "../testing/repo-paths";

const BACKEND_ROOT = join(__dirname, "..", "..", "..");
const BACKEND_MANIFEST = join(BACKEND_ROOT, "module-manifest.json");
/*
  Resolved, not assumed: the repositories are siblings named
  `<something>-backend` and `<something>-frontend`, never `<repo>/frontend`.
  The hardcoded path made this suite die with ENOENT in every checkout, which
  reads as "the manifest was deleted" rather than "this layout has no such
  directory".
*/
const FRONTEND_MANIFEST = frontendPath("lib", "module-manifest.json");

interface ManifestModule {
  id: string;
  administersNamespaces: string[];
  route: string | null;
  productKey: string | null;
  planGated: boolean;
  administrable: boolean;
  ladder: string;
}

interface Manifest {
  version: number;
  modules: ManifestModule[];
}

function readManifest(path: string): Manifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("modules" in parsed) ||
    !Array.isArray((parsed as { modules: unknown }).modules)
  )
    throw new Error(`${path} is not a module manifest`);
  return parsed as Manifest;
}

function administrationFromRegistry(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const definition of MODULE_REGISTRY)
    map[definition.id] = [...definition.administersNamespaces];
  return map;
}

function administrationFromManifest(manifest: Manifest): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const entry of manifest.modules) map[entry.id] = [...entry.administersNamespaces];
  return map;
}

describe.each([
  ["backend", BACKEND_MANIFEST],
  ["frontend", FRONTEND_MANIFEST],
])("%s module manifest tracks MODULE_REGISTRY", (_label, path) => {
  const manifest = readManifest(path);

  it("was actually read, so a passing assertion means something", () => {
    expect(manifest.modules.length).toBe(MODULE_REGISTRY.length);
    expect(manifest.version).toBe(MODULE_MANIFEST_VERSION);
  });

  // The ownership half of the contract: a namespace moved between modules with no regeneration fails here rather than at a user's screen.
  it("carries the same administersNamespaces per module as the registry", () => {
    expect(administrationFromManifest(manifest)).toEqual(administrationFromRegistry());
  });

  it("keeps the route, productKey, planGated, administrable and ladder facts in step", () => {
    const fromManifest = manifest.modules
      .map((entry) => ({
        id: entry.id,
        route: entry.route,
        productKey: entry.productKey,
        planGated: entry.planGated,
        administrable: entry.administrable,
        ladder: entry.ladder,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const fromRegistry = MODULE_REGISTRY.map((definition) => ({
      id: definition.id,
      route: definition.route,
      productKey: definition.productKey,
      planGated: definition.planGated,
      administrable: definition.administrable,
      ladder: definition.ladder,
    }))
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));

    expect(fromManifest).toEqual(fromRegistry);
  });
});

describe("the two committed manifests agree with each other", () => {
  it("declares the same administering relationships on both sides", () => {
    expect(administrationFromManifest(readManifest(FRONTEND_MANIFEST))).toEqual(
      administrationFromManifest(readManifest(BACKEND_MANIFEST)),
    );
  });

  // Bite proof: the comparison the two tests above rely on must fail on a real drift, not silently compare nothing.
  it("fails when a namespace moves to a different administering module", () => {
    const drifted = readManifest(BACKEND_MANIFEST);
    const home = drifted.modules.find((entry) => entry.id === "home");
    expect(home?.administersNamespaces).toContain("chat");
    if (!home) throw new Error("home is not in the manifest");
    home.administersNamespaces = home.administersNamespaces.filter(
      (namespace) => namespace !== "chat",
    );

    expect(administrationFromManifest(drifted)).not.toEqual(administrationFromRegistry());
  });
});
