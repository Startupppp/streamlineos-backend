import { CrmAttentionAdapter } from "./crm-attention-adapter";
import { AttentionAdapterRegistry } from "../attention/attention-adapter.registry";
import { makeFakeDb } from "../../test/fake-select-db";
import type { Db } from "../../db/drizzle.module";

function makeActivityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activity_id: "act-1",
    organization_id: "org-1",
    kind: "task",
    occurred_at: new Date("2026-09-01T10:00:00Z"),
    subject: "Follow up",
    body: null,
    due_at: null,
    completed_at: null,
    assignee_user_id: "user-1",
    deleted_at: null,
    ...overrides,
  };
}

function makeAdapter(rows: Record<string, unknown>[]) {
  const db = makeFakeDb({ activities: rows }) as unknown as Db;
  const registry = new AttentionAdapterRegistry();
  new CrmAttentionAdapter(db, registry).onModuleInit();
  const registered = registry.list().find((a) => a.kindLabel === "crm_task")!;
  return { registry, registered };
}

describe("CrmAttentionAdapter — registration", () => {
  it("registers with module crm, kindLabel crm_task, and permission crm:activities:view", () => {
    const { registered } = makeAdapter([]);
    expect(registered.module).toBe("crm");
    expect(registered.kindLabel).toBe("crm_task");
    expect(registered.permission).toBe("crm:activities:view");
  });

  it("supportsAfterCursor is false: activityId is a text UUID so the integer keyset cannot address it", () => {
    const { registered } = makeAdapter([]);
    expect(registered.supportsAfterCursor).toBe(false);
  });

  it("is idempotent: double onModuleInit registers crm_task exactly once", () => {
    const db = makeFakeDb({ activities: [] }) as unknown as Db;
    const registry = new AttentionAdapterRegistry();
    const adapter = new CrmAttentionAdapter(db, registry);
    adapter.onModuleInit();
    adapter.onModuleInit();
    expect(registry.list()).toHaveLength(1);
  });
});

describe("CrmAttentionAdapter — item shape", () => {
  const OCCURRED = new Date("2026-09-10T08:00:00Z");

  it("returned item has kind module_task, taskKind crm_task, and sourceModule crm", async () => {
    const { registered } = makeAdapter([makeActivityRow({ occurred_at: OCCURRED })]);
    const [item] = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(item?.kind).toBe("module_task");
    expect(item?.taskKind).toBe("crm_task");
    expect(item?.sourceModule).toBe("crm");
  });

  it("dedupKey is task:crm:<activityId> using the row's activity_id", async () => {
    const { registered } = makeAdapter([makeActivityRow({ activity_id: "abc-uuid", occurred_at: OCCURRED })]);
    const [item] = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(item?.dedupKey).toBe("task:crm:abc-uuid");
  });

  it("deepLink is /crm/activities", async () => {
    const { registered } = makeAdapter([makeActivityRow({ occurred_at: OCCURRED })]);
    const [item] = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(item?.deepLink).toBe("/crm/activities");
  });

  it("CONTROL: deepLink does not reference /support so the crm assertion cannot pass vacuously", async () => {
    const { registered } = makeAdapter([makeActivityRow({ occurred_at: OCCURRED })]);
    const [item] = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(item?.deepLink).not.toContain("/support");
  });

  it("timestamp is the occurredAt ISO string", async () => {
    const { registered } = makeAdapter([makeActivityRow({ occurred_at: OCCURRED })]);
    const [item] = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(item?.timestamp).toBe(OCCURRED.toISOString());
  });

  it("dueAt is null when the due_at column is null", async () => {
    const { registered } = makeAdapter([makeActivityRow({ due_at: null, occurred_at: OCCURRED })]);
    const [item] = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(item?.dueAt).toBeNull();
  });

  it("dueAt is the due_at ISO string when due_at is a Date", async () => {
    const dueDate = new Date("2026-10-01T00:00:00Z");
    const { registered } = makeAdapter([makeActivityRow({ due_at: dueDate, occurred_at: OCCURRED })]);
    const [item] = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(item?.dueAt).toBe(dueDate.toISOString());
  });

  it("body is the subject when subject is non-null, body column is ignored", async () => {
    const { registered } = makeAdapter([
      makeActivityRow({ subject: "Call agenda", body: "full notes", occurred_at: OCCURRED }),
    ]);
    const [item] = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(item?.body).toBe("Call agenda");
  });

  it("body falls back to the body column when subject is null", async () => {
    const { registered } = makeAdapter([
      makeActivityRow({ subject: null, body: "full notes", occurred_at: OCCURRED }),
    ]);
    const [item] = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(item?.body).toBe("full notes");
  });

  it("body is empty string when both subject and body columns are null", async () => {
    const { registered } = makeAdapter([makeActivityRow({ subject: null, body: null, occurred_at: OCCURRED })]);
    const [item] = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(item?.body).toBe("");
  });

  it("subject uses the subject column when non-null", async () => {
    const { registered } = makeAdapter([
      makeActivityRow({ subject: "My Subject", occurred_at: OCCURRED }),
    ]);
    const [item] = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(item?.subject).toBe("My Subject");
  });

  it("subject falls back to CRM Task when the subject column is null", async () => {
    const { registered } = makeAdapter([makeActivityRow({ subject: null, occurred_at: OCCURRED })]);
    const [item] = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(item?.subject).toBe("CRM Task");
  });
});

describe("CrmAttentionAdapter — scoping: organizationId column is organization_id, not org_id", () => {
  it("excludes activities from a different org; the matching org row is returned so the negative is not vacuous", async () => {
    const rows = [
      makeActivityRow({ activity_id: "act-other-org", organization_id: "org-other", occurred_at: new Date("2026-09-01T10:00:00Z") }),
      makeActivityRow({ activity_id: "act-own-org", organization_id: "org-1", occurred_at: new Date("2026-09-01T09:00:00Z") }),
    ];
    const { registered } = makeAdapter(rows);
    const result = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(result).toHaveLength(1);
    expect(result[0]?.dedupKey).toBe("task:crm:act-own-org");
  });

  it("excludes activities assigned to a different userId; the matching user's row is returned so the negative is not vacuous", async () => {
    const rows = [
      makeActivityRow({ activity_id: "act-other-user", assignee_user_id: "user-other", occurred_at: new Date("2026-09-01T10:00:00Z") }),
      makeActivityRow({ activity_id: "act-caller", assignee_user_id: "user-1", occurred_at: new Date("2026-09-01T09:00:00Z") }),
    ];
    const { registered } = makeAdapter(rows);
    const result = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(result).toHaveLength(1);
    expect(result[0]?.dedupKey).toBe("task:crm:act-caller");
  });

  it("excludes completed tasks (completedAt non-null); an open task in the same seed is returned", async () => {
    const rows = [
      makeActivityRow({ activity_id: "act-done", completed_at: new Date("2026-09-02T00:00:00Z"), occurred_at: new Date("2026-09-01T10:00:00Z") }),
      makeActivityRow({ activity_id: "act-open", completed_at: null, occurred_at: new Date("2026-09-01T09:00:00Z") }),
    ];
    const { registered } = makeAdapter(rows);
    const result = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(result).toHaveLength(1);
    expect(result[0]?.dedupKey).toBe("task:crm:act-open");
  });

  it("excludes soft-deleted activities (deletedAt non-null); a non-deleted row in the same seed is returned", async () => {
    const rows = [
      makeActivityRow({ activity_id: "act-deleted", deleted_at: new Date("2026-09-03T00:00:00Z"), occurred_at: new Date("2026-09-01T10:00:00Z") }),
      makeActivityRow({ activity_id: "act-live", deleted_at: null, occurred_at: new Date("2026-09-01T09:00:00Z") }),
    ];
    const { registered } = makeAdapter(rows);
    const result = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(result).toHaveLength(1);
    expect(result[0]?.dedupKey).toBe("task:crm:act-live");
  });

  it("excludes non-task activities (kind=email); a kind=task row in the same seed is returned", async () => {
    const rows = [
      makeActivityRow({ activity_id: "act-email", kind: "email", occurred_at: new Date("2026-09-01T10:00:00Z") }),
      makeActivityRow({ activity_id: "act-task", kind: "task", occurred_at: new Date("2026-09-01T09:00:00Z") }),
    ];
    const { registered } = makeAdapter(rows);
    const result = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(result).toHaveLength(1);
    expect(result[0]?.dedupKey).toBe("task:crm:act-task");
  });
});

describe("CrmAttentionAdapter — empty assignee identity", () => {
  const SEED = [makeActivityRow({ activity_id: "act-1", occurred_at: new Date("2026-09-01T10:00:00Z") })];

  it("fetch returns [] for a userId with no assigned activities; same rows return one item for the real assignee", async () => {
    const { registered } = makeAdapter(SEED);
    const empty = await registered.fetch("org-1", "user-nobody", null, 25, null);
    const present = await registered.fetch("org-1", "user-1", null, 25, null);
    expect(empty).toHaveLength(0);
    expect(present).toHaveLength(1);
  });

  it("countPending returns 0 for a userId with no matching activities; returns 1 for the real assignee over the same seed", async () => {
    const { registered } = makeAdapter(SEED);
    const zero = await registered.countPending("org-1", "user-nobody", null);
    const one = await registered.countPending("org-1", "user-1", null);
    expect(zero).toBe(0);
    expect(one).toBe(1);
  });
});

describe("CrmAttentionAdapter — countPending", () => {
  it("countPending returns exactly the number of items fetch returns for the same predicate and seed", async () => {
    const rows = [
      makeActivityRow({ activity_id: "act-a", occurred_at: new Date("2026-09-01T10:00:00Z") }),
      makeActivityRow({ activity_id: "act-b", occurred_at: new Date("2026-09-02T10:00:00Z") }),
      makeActivityRow({ activity_id: "act-c", occurred_at: new Date("2026-09-03T10:00:00Z") }),
    ];
    const { registered } = makeAdapter(rows);
    const items = await registered.fetch("org-1", "user-1", null, 25, null);
    const count = await registered.countPending("org-1", "user-1", null);
    expect(count).toBe(items.length);
    expect(count).toBe(3);
  });
});
