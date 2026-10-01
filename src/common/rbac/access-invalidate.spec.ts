import { bumpPermissionsVersion } from "./access-invalidate";
import { accessVersionChannel } from "./access-version-channel";
import type { DbOrTx } from "./access-invalidate";
import { runWithTenantContext } from "../tenant/tenant-context";

const ABSENT_ROW_VERSION = 1;

interface Stored {
  orgId: string;
  permissionsVersion: number;
}

function makeVersionTable() {
  const rows = new Map<string, Stored>();

  const tx = {
    insert() {
      return {
        values(value: { orgId: string; permissionsVersion?: number }) {
          return {
            async onConflictDoUpdate(config: { set: { permissionsVersion: unknown } }) {
              const existing = rows.get(value.orgId);
              if (existing) {
                void config;
                existing.permissionsVersion += 1;
                return;
              }
              rows.set(value.orgId, {
                orgId: value.orgId,
                permissionsVersion: value.permissionsVersion ?? ABSENT_ROW_VERSION,
              });
            },
          };
        },
      };
    },
  } as unknown as DbOrTx;

  const readAsResolverDoes = (orgId: string): number =>
    rows.get(orgId)?.permissionsVersion ?? ABSENT_ROW_VERSION;

  return { tx, readAsResolverDoes };
}

describe("bumpPermissionsVersion", () => {
  afterEach(() => jest.restoreAllMocks());

  it("moves the version off the value a reader sees when no row exists", async () => {
    const { tx, readAsResolverDoes } = makeVersionTable();
    const before = readAsResolverDoes("org-1");

    await bumpPermissionsVersion(tx, "org-1");

    expect(readAsResolverDoes("org-1")).not.toBe(before);
  });

  it("keeps moving the version on every later bump", async () => {
    const { tx, readAsResolverDoes } = makeVersionTable();
    const seen = new Set<number>([readAsResolverDoes("org-1")]);

    for (let i = 0; i < 3; i += 1) {
      await bumpPermissionsVersion(tx, "org-1");
      seen.add(readAsResolverDoes("org-1"));
    }

    expect(seen.size).toBe(4);
  });

  it("never moves the version backwards", async () => {
    const { tx, readAsResolverDoes } = makeVersionTable();
    let previous = readAsResolverDoes("org-1");

    for (let i = 0; i < 3; i += 1) {
      await bumpPermissionsVersion(tx, "org-1");
      const current = readAsResolverDoes("org-1");
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it("publishes the bump only after commit, never inside the transaction", async () => {
    const { tx } = makeVersionTable();
    const afterCommit: Array<() => Promise<unknown>> = [];
    const publish = jest.spyOn(accessVersionChannel, "publish");

    await runWithTenantContext(
      { orgId: "org-1", audience: "INTERNAL", tx: tx as never, afterCommit },
      () => bumpPermissionsVersion(tx, "org-1"),
    );

    expect(publish).not.toHaveBeenCalled();
    expect(afterCommit).toHaveLength(1);

    await afterCommit[0]!();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("org-1");
  });

  it("publishes inline when no after-commit context exists, never dropping the bump", async () => {
    const { tx } = makeVersionTable();
    const publish = jest.spyOn(accessVersionChannel, "publish");

    await bumpPermissionsVersion(tx, "org-1");

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("org-1");
  });
});
