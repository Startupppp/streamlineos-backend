import { purgeRetiredObject } from "../cron-hr-retention.service";
import { storagePendingPurge } from "../../../db/schema/common/storage-pending-purge";
import type { Db } from "../../../db/drizzle.module";

const ORG = "11111111-1111-4111-8111-111111111111";
const KEY = `${ORG}/documents/1-contract.pdf`;

interface Call {
  op: "insert" | "update" | "delete";
  table: unknown;
  values?: Record<string, unknown>;
}

function harness(deleteBehaviour: "ok" | "throws") {
  const calls: Call[] = [];
  const db = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        calls.push({ op: "insert", table, values });
        const settled = Promise.resolve([]);
        return Object.assign(settled, { onConflictDoUpdate: () => settled });
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          calls.push({ op: "update", table, values });
          return Promise.resolve([]);
        },
      }),
    }),
  } as unknown as Db;

  const storage = {
    deleteFileIfPresent: jest.fn(async () => {
      calls.push({ op: "delete", table: null });
      if (deleteBehaviour === "throws") throw new Error("R2 unreachable");
      return true;
    }),
  };

  const logged: string[] = [];
  return { calls, db, storage, logged, log: (m: string) => logged.push(m) };
}

/**
 * PRD-C103: "GDPR/retention deletion must clean database rows and objects
 * without orphaning".
 *
 * The retention sweep removes the row and then deletes the object. Before the
 * ledger row existed, a delete that failed for any transient reason was
 * permanent: the row that held the key was already gone, nothing else pointed at
 * the object, and the sweep simply counted an orphan and moved on. The ordering
 * below is therefore the whole guarantee — a write-ahead record, then the
 * delete, then the confirmation.
 */
describe("purgeRetiredObject — the ledger row is written before the object is deleted", () => {
  it("records the pending purge first, then deletes, then confirms", async () => {
    const h = harness("ok");

    await expect(purgeRetiredObject(h.db, h.storage, ORG, KEY, h.log)).resolves.toBe(true);

    expect(h.calls.map((c) => c.op)).toEqual(["insert", "delete", "update"]);
    expect(h.calls[0]?.table).toBe(storagePendingPurge);
    expect(h.calls[0]?.values).toEqual({
      orgId: ORG,
      storageKey: KEY,
      purpose: "hr-retention:retired-object",
      bucket: "default",
      status: "pending",
    });
    expect(h.calls[2]?.values?.status).toBe("confirmed");
  });

  it("leaves the purge row PENDING when the object delete fails, so the sweep retries it", async () => {
    const h = harness("throws");

    await expect(purgeRetiredObject(h.db, h.storage, ORG, KEY, h.log)).resolves.toBe(false);

    expect(h.calls.map((c) => c.op)).toEqual(["insert", "delete"]);
    expect(h.calls.some((c) => c.op === "update")).toBe(false);
    expect(h.logged).toHaveLength(1);
  });

  /**
   * `bucket` is not decoration. The storage sweep refuses a row whose bucket it
   * cannot resolve, because an S3 delete of an absent key answers SUCCESS and
   * confirming from the wrong bucket destroys the last pointer while the object
   * survives. `hr-retention:retired-object` is not in the sweep's purpose map, so
   * the recorded role is the only thing that makes this row drainable.
   */
  it("records the bucket role, without which the storage sweep cannot drain the row", async () => {
    const h = harness("ok");
    await purgeRetiredObject(h.db, h.storage, ORG, KEY, h.log);
    expect(h.calls[0]?.values?.bucket).toBe("default");
  });
});
