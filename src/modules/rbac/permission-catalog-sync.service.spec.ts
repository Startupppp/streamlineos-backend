import { classifyRetiredPermissions } from "./permission-catalog-sync.service";
import { permissions } from "../../db/schema";

describe("classifyRetiredPermissions", () => {
  it("deletes only stale keys without persisted role or delegation grants", () => {
    expect(
      classifyRetiredPermissions(
        ["legacy:unused:view", "legacy:assigned:view"],
        ["legacy:assigned:view"],
      ),
    ).toEqual({
      deletableKeys: ["legacy:unused:view"],
      retainedKeys: ["legacy:assigned:view"],
    });
  });

  it("retains every referenced key regardless of which grant source found it", () => {
    expect(
      classifyRetiredPermissions(
        ["legacy:role:view", "legacy:delegated:view", "legacy:unused:view"],
        ["legacy:role:view", "legacy:delegated:view"],
      ),
    ).toEqual({
      deletableKeys: ["legacy:unused:view"],
      retainedKeys: ["legacy:delegated:view", "legacy:role:view"],
    });
  });

  it("keeps cleanup deterministic for audit output", () => {
    expect(
      classifyRetiredPermissions(
        ["z:resource:view", "a:resource:view"],
        [],
      ),
    ).toEqual({
      deletableKeys: ["a:resource:view", "z:resource:view"],
      retainedKeys: [],
    });
  });
});

describe("PermissionCatalogSyncService.sync — administering module column", () => {
  async function runSync(catalogModules: string[]) {
    const { PermissionCatalogSyncService } = await import(
      "./permission-catalog-sync.service"
    );
    const { RoleGrantReconcilerService } = await import(
      "./role-grant-reconciler.service"
    );
    let inserted: Array<Record<string, unknown>> = [];
    let conflictSet: Record<string, unknown> = {};

    const db = {
      select: () => ({
        from: () => ({
          limit: () =>
            Promise.resolve(catalogModules.map((moduleKey) => ({ moduleKey }))),
        }),
      }),
      /*
       * Keyed on the table: since ed6c7bef2 the sync self-heals `modules_catalog`
       * with an insert of its own before the permission rows go in, and a double
       * that captured the first insert it saw recorded module rows as permissions.
       */
      insert: (table: unknown) => ({
        values: (rows: Array<Record<string, unknown>>) => {
          if (table === permissions && inserted.length === 0) inserted = rows;
          return {
            onConflictDoUpdate: (args: { set: Record<string, unknown> }) => {
              if (Object.keys(conflictSet).length === 0) conflictSet = args.set;
              return Promise.resolve();
            },
            onConflictDoNothing: () => Promise.resolve(),
          };
        },
      }),
      selectDistinct: () => ({ from: () => Promise.resolve([]) }),
      delete: () => ({ where: () => Promise.resolve() }),
    };

    const service = new PermissionCatalogSyncService(
      db as never,
      new RoleGrantReconcilerService(db as never),
    );
    await service.sync().catch(() => undefined);
    return { inserted, conflictSet };
  }

  it("sets administeringModuleKey for a key whose administering module is in the catalog", async () => {
    const { inserted } = await runSync(["hr", "home", "crm"]);
    const hrKey = inserted.find((row) => row.name === "hr:employees:view");
    expect(hrKey).toBeDefined();
    expect(hrKey?.administeringModuleKey).toBe("hr");
  });

  it("folds chat keys onto home, matching the composite foreign key", async () => {
    const { inserted } = await runSync(["hr", "home", "crm"]);
    const chatKey = inserted.find((row) => row.name === "chat:messages:read");
    expect(chatKey?.administeringModuleKey).toBe("home");
  });

  it("leaves a platform namespace null so it can never be granted per person", async () => {
    const { inserted } = await runSync(["hr", "home", "crm"]);
    const settingsKey = inserted.find((row) => row.name === "settings:manage");
    expect(settingsKey).toBeDefined();
    expect(settingsKey?.administeringModuleKey).toBeNull();
  });

  it("re-syncs the column on conflict, so an existing row is corrected rather than left stale", async () => {
    const { conflictSet } = await runSync(["hr", "home", "crm"]);
    expect(conflictSet).toHaveProperty("administeringModuleKey");
  });

  it("never invents a module the catalog does not have", async () => {
    const { inserted } = await runSync([]);
    for (const row of inserted) expect(row.administeringModuleKey).toBeNull();
  });
});
