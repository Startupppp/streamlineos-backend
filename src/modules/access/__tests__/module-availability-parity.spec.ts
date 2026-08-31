import { readFileSync, readdirSync } from "fs";
import path from "path";
import {
  moduleAvailability,
  moduleAvailabilityResolver,
  type ModuleAvailabilityResolver,
  type ModuleAvailabilityResult,
} from "../../../common/rbac/module-availability";
import { isCoreModuleKey } from "../entitlements.service";

const ORG = "org-1";
const USER = "user-1";

const CORE_MODULE = "chat";
const GATED_MODULE = "hr";
const PLATFORM_ADMIN_MODULE = "billing";

type OrgRow = boolean | undefined;

/** Mirrors authorize.ts: a narrow per-key read whose `undefined` survives, plus the real plan list. */
function buildAuthorizeResolver(
  moduleKey: string,
  orgRow: OrgRow,
  planLocked: boolean,
  denied: Set<string>,
): ModuleAvailabilityResolver {
  return moduleAvailabilityResolver(
    {
      isCoreModule: isCoreModuleKey,
      getModuleMap: async (): Promise<Record<string, boolean>> =>
        orgRow === undefined ? {} : { [moduleKey]: orgRow },
      getPlanLockedModules: async (): Promise<readonly string[]> =>
        planLocked ? [moduleKey] : [],
    },
    { getUserDeniedModules: async (): Promise<Set<string>> => new Set(denied) },
  );
}

function buildSnapshotResolver(
  moduleKey: string,
  rawMap: Record<string, boolean>,
  planLocked: boolean,
  denied: Set<string>,
): ModuleAvailabilityResolver {
  return moduleAvailabilityResolver(
    {
      isCoreModule: isCoreModuleKey,
      getModuleMap: async (): Promise<Record<string, boolean>> => rawMap,
      getPlanLockedModules: async (): Promise<readonly string[]> =>
        planLocked ? [moduleKey] : [],
    },
    { getUserDeniedModules: async (): Promise<Set<string>> => new Set(denied) },
  );
}

function buildGuardResolver(
  moduleKey: string,
  orgRow: OrgRow,
  planLocked: boolean,
  denied: Set<string>,
): ModuleAvailabilityResolver {
  const rawMap: Record<string, boolean> =
    orgRow === undefined ? {} : { [moduleKey]: orgRow };
  return moduleAvailabilityResolver(
    {
      isCoreModule: isCoreModuleKey,
      getModuleMap: async (): Promise<Record<string, boolean>> => rawMap,
      getPlanLockedModules: async (): Promise<readonly string[]> =>
        planLocked ? [moduleKey] : [],
    },
    { getUserDeniedModules: async (): Promise<Set<string>> => new Set(denied) },
  );
}

function runCheck(
  resolver: ModuleAvailabilityResolver,
  moduleKey: string,
): Promise<ModuleAvailabilityResult> {
  return moduleAvailability(resolver, ORG, USER, moduleKey);
}

function flattenRow(row: OrgRow): boolean {
  return row === true;
}

describe("module-availability parity: snapshot ↔ authorize ↔ guard", () => {
  const NONE = new Set<string>();
  const DENY_CORE = new Set<string>([CORE_MODULE]);
  const DENY_GATED = new Set<string>([GATED_MODULE]);

  describe("core module: chat (planGated=false, administrable=true)", () => {
    it("org row absent, no deny — all three return available", async () => {
      const auth = await runCheck(
        buildAuthorizeResolver(CORE_MODULE, undefined, false, NONE),
        CORE_MODULE,
      );
      const snap = await runCheck(
        buildSnapshotResolver(CORE_MODULE, {}, false, NONE),
        CORE_MODULE,
      );
      const guard = await runCheck(
        buildGuardResolver(CORE_MODULE, undefined, false, NONE),
        CORE_MODULE,
      );

      expect(auth).toEqual({ available: true });
      expect(snap).toEqual({ available: true });
      expect(guard).toEqual({ available: true });
    });

    it("org row enabled, no deny — all three return available", async () => {
      const auth = await runCheck(
        buildAuthorizeResolver(CORE_MODULE, true, false, NONE),
        CORE_MODULE,
      );
      const snap = await runCheck(
        buildSnapshotResolver(CORE_MODULE, { [CORE_MODULE]: true }, false, NONE),
        CORE_MODULE,
      );
      const guard = await runCheck(
        buildGuardResolver(CORE_MODULE, true, false, NONE),
        CORE_MODULE,
      );

      expect(auth).toEqual({ available: true });
      expect(snap).toEqual({ available: true });
      expect(guard).toEqual({ available: true });
    });

    it("org row disabled, no deny — all three return available (core ignores org row)", async () => {
      const auth = await runCheck(
        buildAuthorizeResolver(CORE_MODULE, false, false, NONE),
        CORE_MODULE,
      );
      const snap = await runCheck(
        buildSnapshotResolver(CORE_MODULE, { [CORE_MODULE]: false }, false, NONE),
        CORE_MODULE,
      );
      const guard = await runCheck(
        buildGuardResolver(CORE_MODULE, false, false, NONE),
        CORE_MODULE,
      );

      expect(auth).toEqual({ available: true });
      expect(snap).toEqual({ available: true });
      expect(guard).toEqual({ available: true });
    });

    it("user denied, org row absent — all three return available (core ignores deny)", async () => {
      const auth = await runCheck(
        buildAuthorizeResolver(CORE_MODULE, undefined, false, DENY_CORE),
        CORE_MODULE,
      );
      const snap = await runCheck(
        buildSnapshotResolver(CORE_MODULE, {}, false, DENY_CORE),
        CORE_MODULE,
      );
      const guard = await runCheck(
        buildGuardResolver(CORE_MODULE, undefined, false, DENY_CORE),
        CORE_MODULE,
      );

      expect(auth).toEqual({ available: true });
      expect(snap).toEqual({ available: true });
      expect(guard).toEqual({ available: true });
    });

    it("user denied, org row disabled — all three return available (core is absolute)", async () => {
      const auth = await runCheck(
        buildAuthorizeResolver(CORE_MODULE, false, false, DENY_CORE),
        CORE_MODULE,
      );
      const snap = await runCheck(
        buildSnapshotResolver(CORE_MODULE, { [CORE_MODULE]: false }, false, DENY_CORE),
        CORE_MODULE,
      );
      const guard = await runCheck(
        buildGuardResolver(CORE_MODULE, false, false, DENY_CORE),
        CORE_MODULE,
      );

      expect(auth).toEqual({ available: true });
      expect(snap).toEqual({ available: true });
      expect(guard).toEqual({ available: true });
    });
  });

  describe("plan-gated module: hr (planGated=true, administrable=true)", () => {
    it("org row enabled, no deny — all three return available", async () => {
      const auth = await runCheck(
        buildAuthorizeResolver(GATED_MODULE, true, false, NONE),
        GATED_MODULE,
      );
      const snap = await runCheck(
        buildSnapshotResolver(GATED_MODULE, { [GATED_MODULE]: true }, false, NONE),
        GATED_MODULE,
      );
      const guard = await runCheck(
        buildGuardResolver(GATED_MODULE, true, false, NONE),
        GATED_MODULE,
      );

      expect(auth).toEqual({ available: true });
      expect(snap).toEqual({ available: true });
      expect(guard).toEqual({ available: true });
    });

    it("org row disabled, no deny — all three return org-disabled", async () => {
      const auth = await runCheck(
        buildAuthorizeResolver(GATED_MODULE, false, false, NONE),
        GATED_MODULE,
      );
      const snap = await runCheck(
        buildSnapshotResolver(GATED_MODULE, { [GATED_MODULE]: false }, false, NONE),
        GATED_MODULE,
      );
      const guard = await runCheck(
        buildGuardResolver(GATED_MODULE, false, false, NONE),
        GATED_MODULE,
      );

      expect(auth).toEqual({ available: false, reason: "org-disabled" });
      expect(snap).toEqual({ available: false, reason: "org-disabled" });
      expect(guard).toEqual({ available: false, reason: "org-disabled" });
    });

    it("org row absent, not plan-locked — all three return org-disabled", async () => {
      const auth = await runCheck(
        buildAuthorizeResolver(GATED_MODULE, undefined, false, NONE),
        GATED_MODULE,
      );
      const snap = await runCheck(
        buildSnapshotResolver(GATED_MODULE, {}, false, NONE),
        GATED_MODULE,
      );
      const guard = await runCheck(
        buildGuardResolver(GATED_MODULE, undefined, false, NONE),
        GATED_MODULE,
      );

      expect(auth).toEqual({ available: false, reason: "org-disabled" });
      expect(snap).toEqual({ available: false, reason: "org-disabled" });
      expect(guard).toEqual({ available: false, reason: "org-disabled" });
    });

    it("org row absent, plan-locked — all three return not-in-plan", async () => {
      const auth = await runCheck(
        buildAuthorizeResolver(GATED_MODULE, undefined, true, NONE),
        GATED_MODULE,
      );
      const snap = await runCheck(
        buildSnapshotResolver(GATED_MODULE, {}, true, NONE),
        GATED_MODULE,
      );
      const guard = await runCheck(
        buildGuardResolver(GATED_MODULE, undefined, true, NONE),
        GATED_MODULE,
      );

      expect(auth).toEqual({ available: false, reason: "not-in-plan" });
      expect(snap).toEqual({ available: false, reason: "not-in-plan" });
      expect(guard).toEqual({ available: false, reason: "not-in-plan" });
    });

    it("user denied, org row enabled — all three return user-denied", async () => {
      const auth = await runCheck(
        buildAuthorizeResolver(GATED_MODULE, true, false, DENY_GATED),
        GATED_MODULE,
      );
      const snap = await runCheck(
        buildSnapshotResolver(GATED_MODULE, { [GATED_MODULE]: true }, false, DENY_GATED),
        GATED_MODULE,
      );
      const guard = await runCheck(
        buildGuardResolver(GATED_MODULE, true, false, DENY_GATED),
        GATED_MODULE,
      );

      expect(auth).toEqual({ available: false, reason: "user-denied" });
      expect(snap).toEqual({ available: false, reason: "user-denied" });
      expect(guard).toEqual({ available: false, reason: "user-denied" });
    });

    it("user denied, org row disabled — all three return user-denied (deny precedes org row check)", async () => {
      const auth = await runCheck(
        buildAuthorizeResolver(GATED_MODULE, false, false, DENY_GATED),
        GATED_MODULE,
      );
      const snap = await runCheck(
        buildSnapshotResolver(GATED_MODULE, { [GATED_MODULE]: false }, false, DENY_GATED),
        GATED_MODULE,
      );
      const guard = await runCheck(
        buildGuardResolver(GATED_MODULE, false, false, DENY_GATED),
        GATED_MODULE,
      );

      expect(auth).toEqual({ available: false, reason: "user-denied" });
      expect(snap).toEqual({ available: false, reason: "user-denied" });
      expect(guard).toEqual({ available: false, reason: "user-denied" });
    });

    it("user denied, org row absent, plan-locked — all three return user-denied (deny precedes plan check)", async () => {
      const auth = await runCheck(
        buildAuthorizeResolver(GATED_MODULE, undefined, true, DENY_GATED),
        GATED_MODULE,
      );
      const snap = await runCheck(
        buildSnapshotResolver(GATED_MODULE, {}, true, DENY_GATED),
        GATED_MODULE,
      );
      const guard = await runCheck(
        buildGuardResolver(GATED_MODULE, undefined, true, DENY_GATED),
        GATED_MODULE,
      );

      expect(auth).toEqual({ available: false, reason: "user-denied" });
      expect(snap).toEqual({ available: false, reason: "user-denied" });
      expect(guard).toEqual({ available: false, reason: "user-denied" });
    });
  });

  describe("billing module (planGated=false, ladder=platform-admin)", () => {
    it("org row absent — all three return available: billing is core, and no org carries a row for it", async () => {
      const auth = await runCheck(
        buildAuthorizeResolver(PLATFORM_ADMIN_MODULE, undefined, false, NONE),
        PLATFORM_ADMIN_MODULE,
      );
      const snap = await runCheck(
        buildSnapshotResolver(PLATFORM_ADMIN_MODULE, {}, false, NONE),
        PLATFORM_ADMIN_MODULE,
      );
      const guard = await runCheck(
        buildGuardResolver(PLATFORM_ADMIN_MODULE, undefined, false, NONE),
        PLATFORM_ADMIN_MODULE,
      );

      expect(auth).toEqual({ available: true });
      expect(snap).toEqual({ available: true });
      expect(guard).toEqual({ available: true });
    });
  });
});

describe("ModuleAvailabilityResolver assembly guard", () => {
  it("no production source file constructs a ModuleAvailabilityResolver object literal", () => {
    const srcRoot = path.resolve(__dirname, "../../..");
    const allowedPaths = new Set([
      path.resolve(srcRoot, "common/rbac/module-availability.ts"),
    ]);

    function walk(dir: string, out: string[]): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, out);
        } else if (
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".spec.ts") &&
          !entry.name.endsWith(".e2e-spec.ts")
        ) {
          out.push(full);
        }
      }
    }

    function hasResolverLiteral(content: string): boolean {
      const startMarker = "isCoreModule:";
      let searchFrom = 0;
      while (true) {
        const markerIdx = content.indexOf(startMarker, searchFrom);
        if (markerIdx === -1) return false;
        let depth = 0;
        for (let i = markerIdx + startMarker.length; i < content.length; i++) {
          if (content[i] === "{") depth++;
          if (content[i] === "}") {
            if (depth === 0) break;
            depth--;
          }
          if (content.startsWith("getUserDeniedModules:", i)) return true;
        }
        searchFrom = markerIdx + 1;
      }
    }

    const files: string[] = [];
    walk(srcRoot, files);
    const offenders = files
      .filter((f) => !allowedPaths.has(f))
      .filter((f) => hasResolverLiteral(readFileSync(f, "utf-8")));

    expect(offenders.map((f) => path.relative(srcRoot, f))).toEqual([]);
  });
});

describe("module-availability key normalization", () => {
  it("matches normalized persisted state when a caller supplies an uppercase key", async () => {
    const resolver = moduleAvailabilityResolver(
      {
        isCoreModule: isCoreModuleKey,
        getModuleMap: async () => ({ hr: true }),
        getPlanLockedModules: async () => [],
      },
      { getUserDeniedModules: async () => new Set<string>() },
    );

    await expect(moduleAvailability(resolver, ORG, USER, "HR")).resolves.toEqual({
      available: true,
    });
  });
});
