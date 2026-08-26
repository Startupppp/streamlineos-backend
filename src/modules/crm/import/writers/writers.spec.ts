import { activities, deals, subjects } from "../../../../db/schema";
import type { TenantTx } from "../../../../db/drizzle.types";
import { ANCHOR_PARTY_ID } from "../import-entities";
import { canUpdate, writerFor, type WriteContext } from ".";

/**
 * The writers, against the constraints that actually refuse them.
 *
 * Every assertion here is about a CHECK on the table underneath — the actor
 * pair on `activities`, its single anchor, its task-only due date — or about a
 * NOT NULL a file cannot supply. Those are the failures that arrive as a 23514
 * on row four thousand of somebody's commit rather than at review time, which
 * is precisely why they are worth pinning without a database.
 */

interface Written {
  table: unknown;
  values: Record<string, unknown>;
  set: Record<string, unknown> | null;
}

/** Just enough of a transaction to see what a writer would send. */
class FakeTx {
  readonly written: Written[] = [];

  constructor(private readonly returns: Record<string, unknown> = {}) {}

  get tx(): TenantTx {
    return {
      insert: (table: unknown) => this.builder(table),
      update: (table: unknown) => this.builder(table),
    } as unknown as TenantTx;
  }

  inserted(table: unknown): Record<string, unknown> | undefined {
    return this.written.find((row) => row.table === table && row.set === null)?.values;
  }

  updated(table: unknown): Record<string, unknown> | undefined {
    return this.written.find((row) => row.table === table && row.set !== null)?.set ?? undefined;
  }

  private builder(table: unknown) {
    const record: Written = { table, values: {}, set: null };
    const self: Record<string, unknown> = {
      values: (payload: Record<string, unknown>) => {
        record.values = payload;
        return self;
      },
      set: (payload: Record<string, unknown>) => {
        record.set = payload;
        return self;
      },
      where: () => self,
      limit: () => self,
      returning: () => self,
      then: (resolve: (value: unknown) => void) => {
        this.written.push(record);
        return Promise.resolve([this.returns]).then(resolve);
      },
    };

    return self;
  }
}

const context = (over: Partial<WriteContext> = {}): WriteContext => ({
  organizationId: "org-1",
  subjectTypeId: null,
  pipelineId: null,
  ...over,
});

describe("the subject writer", () => {
  it("refuses a file with no subject type rather than writing a broken row", async () => {
    const fake = new FakeTx({ subjectId: "subject-1" });

    await expect(
      writerFor("subject").create(fake.tx, context(), { values: { title: "12 Oak Lane" }, customFields: null }),
    ).rejects.toThrow(/subject type/i);
  });

  it("writes the three platform columns and leaves the rest as declared values", async () => {
    const fake = new FakeTx({ subjectId: "subject-1" });

    const id = await writerFor("subject").create(fake.tx, context({ subjectTypeId: "type-1" }), {
      values: { title: "12 Oak Lane", reference: "REF-1", status: "Listed" },
      customFields: { bedrooms: "4" },
    });

    expect(id).toBe("subject-1");
    expect(fake.inserted(subjects)).toMatchObject({
      organizationId: "org-1",
      subjectTypeId: "type-1",
      title: "12 Oak Lane",
      reference: "REF-1",
      // A subject type's declared field values live here; this is their home,
      // not a column that failed to be recognised.
      customFields: { bedrooms: "4" },
    });
  });

  /**
   * Merged rather than replaced. Replacing would erase every declared field
   * this particular export did not carry, which is most of them most of the time.
   */
  it("keeps declared values the file did not carry", async () => {
    const fake = new FakeTx({});
    const updates = writerFor("subject").updates;
    if (!updates) throw new Error("the subject writer has an update path");

    await updates.fillGaps(
      fake.tx,
      context({ subjectTypeId: "type-1" }),
      "subject-1",
      { title: "12 Oak Lane", status: null, customFields: { bedrooms: "4", garden: "yes" } },
      { values: { status: "Sold" }, customFields: { bedrooms: "5" } },
    );

    expect(fake.updated(subjects)).toMatchObject({
      status: "Sold",
      customFields: { bedrooms: "5", garden: "yes" },
    });
  });

  it("does not overwrite a title somebody curated", async () => {
    const fake = new FakeTx({});
    const updates = writerFor("subject").updates;
    if (!updates) throw new Error("the subject writer has an update path");

    await updates.fillGaps(
      fake.tx,
      context({ subjectTypeId: "type-1" }),
      "subject-1",
      { title: "The one by the park", customFields: null },
      { values: { title: "12 Oak Lane" }, customFields: null },
    );

    expect(fake.updated(subjects)?.title).toBeUndefined();
  });

  it("leaves the record in the database when it takes it back", async () => {
    const fake = new FakeTx({});
    await writerFor("subject").remove(fake.tx, context({ subjectTypeId: "type-1" }), "subject-1");
    expect(fake.updated(subjects)?.deletedAt).toBeInstanceOf(Date);
  });
});

describe("the pipeline writer", () => {
  it("writes the minor units the plan already coerced, not the file's spelling", async () => {
    const fake = new FakeTx({ id: 42 });

    const id = await writerFor("pipeline").create(fake.tx, context({ pipelineId: "pipe-1" }), {
      values: {
        name: "Renewal",
        stage: "Proposal",
        amount: "1250050",
        closeDate: "2026-03-14",
        [ANCHOR_PARTY_ID]: "party-1",
      },
      customFields: { account_name: "Acme Ltd" },
    });

    // `deals.id` is a serial and every outcome column on an import row is text.
    expect(id).toBe("42");
    expect(fake.inserted(deals)).toMatchObject({
      orgId: "org-1",
      name: "Renewal",
      stage: "Proposal",
      valueMinor: 1250050,
      expectedCloseDate: "2026-03-14",
      partyId: "party-1",
      pipelineId: "pipe-1",
    });
  });

  it("lands a deal whose account this organisation does not have", async () => {
    const fake = new FakeTx({ id: 7 });

    await writerFor("pipeline").create(fake.tx, context(), {
      values: { name: "Renewal" },
      customFields: null,
    });

    expect(fake.inserted(deals)).toMatchObject({ partyId: null, pipelineId: null });
  });

  /**
   * Stated as a test rather than a comment. A deal has no unique business key,
   * so no `update` row can be planned for one — and a writer with an update
   * path would invite somebody to plan one.
   */
  it("has no update path, because a deal has no identity to match on", () => {
    expect(canUpdate("pipeline")).toBe(false);
    expect(canUpdate("activity")).toBe(false);
    expect(canUpdate("party")).toBe(true);
    expect(canUpdate("subject")).toBe(true);
  });
});

describe("the activity writer", () => {
  const planned = (over: Record<string, string> = {}) => ({
    values: {
      subject: "Kickoff call",
      kind: "call",
      occurredAt: "2026-02-01T10:00:00.000Z",
      [ANCHOR_PARTY_ID]: "party-1",
      ...over,
    },
    customFields: null,
  });

  /**
   * `chk_activities_actor` allows `system` only with no user id. An imported
   * activity IS a system record — nobody here made the call, the import read it
   * out of somebody else's export — and attributing it to whoever uploaded the
   * file would put two hundred calls they never made under their name.
   */
  it("records itself as the system, carrying nobody's name", async () => {
    const fake = new FakeTx({ activityId: "activity-1" });
    await writerFor("activity").create(fake.tx, context(), planned());

    expect(fake.inserted(activities)).toMatchObject({
      actorKind: "system",
      actorLabel: "import",
      source: "import",
    });
    expect(fake.inserted(activities)?.actorUserId).toBeUndefined();
  });

  /** `chk_activities_one_anchor` requires exactly one, and the plan resolved it. */
  it("refuses a row with nothing to attach it to", async () => {
    const fake = new FakeTx({ activityId: "activity-1" });

    await expect(
      writerFor("activity").create(fake.tx, context(), {
        values: { subject: "Kickoff call" },
        customFields: null,
      }),
    ).rejects.toThrow(/attach/i);
  });

  /** `chk_activities_task_fields`: a due date on an e-mail is a 23514. */
  it("drops a due date on anything that is not a task", async () => {
    const fake = new FakeTx({ activityId: "activity-1" });
    await writerFor("activity").create(
      fake.tx,
      context(),
      planned({ kind: "email", dueAt: "2026-03-01T00:00:00.000Z" }),
    );

    expect(fake.inserted(activities)?.dueAt).toBeNull();
  });

  it("keeps a due date on a task", async () => {
    const fake = new FakeTx({ activityId: "activity-1" });
    await writerFor("activity").create(
      fake.tx,
      context(),
      planned({ kind: "task", dueAt: "2026-03-01T00:00:00.000Z" }),
    );

    expect(fake.inserted(activities)?.dueAt).toBeInstanceOf(Date);
  });

  /**
   * A note claims the least, which is why it is the fallback: it records that
   * something was written down, and that is true of every row in every
   * activities export. Guessing "call" would put an event on a timeline that may
   * never have happened in that form.
   */
  it("falls back to a note rather than guessing what happened", async () => {
    const fake = new FakeTx({ activityId: "activity-1" });
    await writerFor("activity").create(fake.tx, context(), planned({ kind: "fax" }));

    expect(fake.inserted(activities)?.kind).toBe("note");
  });

  it("leaves `occurred_at` to its own default when the file's date was unreadable", async () => {
    const fake = new FakeTx({ activityId: "activity-1" });
    await writerFor("activity").create(fake.tx, context(), {
      values: { subject: "Kickoff call", [ANCHOR_PARTY_ID]: "party-1" },
      customFields: null,
    });

    expect(fake.inserted(activities)?.occurredAt).toBeUndefined();
  });

  it("leaves the record in the database when it takes it back", async () => {
    const fake = new FakeTx({});
    await writerFor("activity").remove(fake.tx, context(), "activity-1");
    expect(fake.updated(activities)?.deletedAt).toBeInstanceOf(Date);
  });
});
