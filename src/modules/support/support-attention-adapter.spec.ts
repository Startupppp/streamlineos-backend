import { SupportAttentionAdapter } from "./support-attention-adapter";
import { AttentionAdapterRegistry } from "../attention/attention-adapter.registry";
import { makeFakeDb } from "../../test/fake-select-db";
import type { Db } from "../../db/drizzle.module";
import type { InboxSourcePosition } from "../notifications/dto/unified-inbox.schemas";
import { supportTicketStatusEnum } from "../../db/schema/common/enums";

function makeTicketRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    org_id: "org-1",
    assignee_membership_id: 10,
    title: "Cannot log in",
    status: "OPEN",
    priority: "MEDIUM",
    sla_deadline: null,
    created_at: new Date("2026-09-01T10:00:00Z"),
    merged_into_ticket_id: null,
    ...overrides,
  };
}

function makeAdapter(rows: Record<string, unknown>[]) {
  const db = makeFakeDb({ support_tickets: rows }) as unknown as Db;
  const registry = new AttentionAdapterRegistry();
  new SupportAttentionAdapter(db, registry).onModuleInit();
  const registered = registry.list().find((a) => a.kindLabel === "support_ticket")!;
  return { registry, registered };
}

describe("SupportAttentionAdapter — open status set verified against enum", () => {
  it("supportTicketStatusEnum declares exactly OPEN, IN_PROGRESS, WAITING as open and RESOLVED, CLOSED as closed", () => {
    const all = supportTicketStatusEnum.enumValues;
    expect(all).toContain("OPEN");
    expect(all).toContain("IN_PROGRESS");
    expect(all).toContain("WAITING");
    expect(all).toContain("RESOLVED");
    expect(all).toContain("CLOSED");
    expect(all).toHaveLength(5);
  });
});

describe("SupportAttentionAdapter — registration", () => {
  it("registers with module support, kindLabel support_ticket, and permission support:tickets:view", () => {
    const { registered } = makeAdapter([]);
    expect(registered.module).toBe("support");
    expect(registered.kindLabel).toBe("support_ticket");
    expect(registered.permission).toBe("support:tickets:view");
  });

  it("supportsAfterCursor is true: ticket id is a serial integer addressable by the integer keyset", () => {
    const { registered } = makeAdapter([]);
    expect(registered.supportsAfterCursor).toBe(true);
  });

  it("is idempotent: double onModuleInit registers support_ticket exactly once", () => {
    const db = makeFakeDb({ support_tickets: [] }) as unknown as Db;
    const registry = new AttentionAdapterRegistry();
    const adapter = new SupportAttentionAdapter(db, registry);
    adapter.onModuleInit();
    adapter.onModuleInit();
    expect(registry.list()).toHaveLength(1);
  });
});

describe("SupportAttentionAdapter — item shape", () => {
  const CREATED = new Date("2026-09-10T08:00:00Z");

  it("returned item has kind module_task, taskKind support_ticket, and sourceModule support", async () => {
    const { registered } = makeAdapter([makeTicketRow({ id: 42, created_at: CREATED })]);
    const [item] = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(item?.kind).toBe("module_task");
    expect(item?.taskKind).toBe("support_ticket");
    expect(item?.sourceModule).toBe("support");
  });

  it("dedupKey is task:support:<id> using the ticket id as a string", async () => {
    const { registered } = makeAdapter([makeTicketRow({ id: 42, created_at: CREATED })]);
    const [item] = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(item?.dedupKey).toBe("task:support:42");
  });

  it("item id is the numeric ticket id cast to string", async () => {
    const { registered } = makeAdapter([makeTicketRow({ id: 42, created_at: CREATED })]);
    const [item] = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(item?.id).toBe("42");
  });

  it("deepLink is /support/inbox", async () => {
    const { registered } = makeAdapter([makeTicketRow({ id: 1, created_at: CREATED })]);
    const [item] = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(item?.deepLink).toBe("/support/inbox");
  });

  it("CONTROL: deepLink does not reference /crm so the support assertion cannot pass vacuously", async () => {
    const { registered } = makeAdapter([makeTicketRow({ id: 1, created_at: CREATED })]);
    const [item] = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(item?.deepLink).not.toContain("/crm");
  });

  it("status is preserved from the DB row, not hardcoded", async () => {
    const { registered } = makeAdapter([makeTicketRow({ id: 1, status: "IN_PROGRESS", created_at: CREATED })]);
    const [item] = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(item?.status).toBe("IN_PROGRESS");
  });

  it("dueAt is null when sla_deadline is null", async () => {
    const { registered } = makeAdapter([makeTicketRow({ id: 1, sla_deadline: null, created_at: CREATED })]);
    const [item] = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(item?.dueAt).toBeNull();
  });

  it("dueAt is the sla_deadline ISO string when sla_deadline is a Date", async () => {
    const sla = new Date("2026-10-15T00:00:00Z");
    const { registered } = makeAdapter([makeTicketRow({ id: 1, sla_deadline: sla, created_at: CREATED })]);
    const [item] = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(item?.dueAt).toBe(sla.toISOString());
  });

  it("body and subject are both set to the ticket title", async () => {
    const { registered } = makeAdapter([makeTicketRow({ id: 1, title: "Login broken", created_at: CREATED })]);
    const [item] = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(item?.body).toBe("Login broken");
    expect(item?.subject).toBe("Login broken");
  });

  it("timestamp is the createdAt ISO string", async () => {
    const { registered } = makeAdapter([makeTicketRow({ id: 1, created_at: CREATED })]);
    const [item] = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(item?.timestamp).toBe(CREATED.toISOString());
  });
});

describe("SupportAttentionAdapter — scoping: orgId column is org_id, assignee is assignee_membership_id", () => {
  it("excludes tickets from a different org; the matching org ticket is returned so the negative is not vacuous", async () => {
    const rows = [
      makeTicketRow({ id: 5, org_id: "org-other", created_at: new Date("2026-09-01T10:00:00Z") }),
      makeTicketRow({ id: 6, org_id: "org-1", created_at: new Date("2026-09-01T09:00:00Z") }),
    ];
    const { registered } = makeAdapter(rows);
    const result = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("6");
  });

  it("excludes tickets assigned to a different membershipId; the caller's ticket is returned so the negative is not vacuous", async () => {
    const rows = [
      makeTicketRow({ id: 7, assignee_membership_id: 999, created_at: new Date("2026-09-01T10:00:00Z") }),
      makeTicketRow({ id: 8, assignee_membership_id: 10, created_at: new Date("2026-09-01T09:00:00Z") }),
    ];
    const { registered } = makeAdapter(rows);
    const result = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("8");
  });

  it("excludes RESOLVED tickets (closed status per enum); an OPEN ticket in the same seed is returned", async () => {
    const rows = [
      makeTicketRow({ id: 9, status: "RESOLVED", created_at: new Date("2026-09-01T10:00:00Z") }),
      makeTicketRow({ id: 11, status: "OPEN", created_at: new Date("2026-09-01T09:00:00Z") }),
    ];
    const { registered } = makeAdapter(rows);
    const result = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("11");
  });

  it("excludes CLOSED tickets (closed status per enum); an IN_PROGRESS ticket in the same seed is returned", async () => {
    const rows = [
      makeTicketRow({ id: 12, status: "CLOSED", created_at: new Date("2026-09-01T10:00:00Z") }),
      makeTicketRow({ id: 13, status: "IN_PROGRESS", created_at: new Date("2026-09-01T09:00:00Z") }),
    ];
    const { registered } = makeAdapter(rows);
    const result = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("13");
  });

  it("includes WAITING as the third open status; a RESOLVED ticket in the same seed is excluded", async () => {
    const rows = [
      makeTicketRow({ id: 14, status: "WAITING", created_at: new Date("2026-09-01T10:00:00Z") }),
      makeTicketRow({ id: 15, status: "RESOLVED", created_at: new Date("2026-09-01T09:00:00Z") }),
    ];
    const { registered } = makeAdapter(rows);
    const result = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("14");
  });

  it("excludes merged tickets (mergedIntoTicketId non-null); a non-merged ticket in the same seed is returned", async () => {
    const rows = [
      makeTicketRow({ id: 16, merged_into_ticket_id: 5, created_at: new Date("2026-09-01T10:00:00Z") }),
      makeTicketRow({ id: 17, merged_into_ticket_id: null, created_at: new Date("2026-09-01T09:00:00Z") }),
    ];
    const { registered } = makeAdapter(rows);
    const result = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("17");
  });
});

describe("SupportAttentionAdapter — null membershipId", () => {
  const SEED = [makeTicketRow({ id: 1, created_at: new Date("2026-09-01T10:00:00Z") })];

  it("fetch returns [] when membershipId is null; same rows return one item with a valid membershipId", async () => {
    const { registered } = makeAdapter(SEED);
    const empty = await registered.fetch("org-1", "user-1", null, 25, null);
    const present = await registered.fetch("org-1", "user-1", 10, 25, null);
    expect(empty).toHaveLength(0);
    expect(present).toHaveLength(1);
  });

  it("countPending returns 0 when membershipId is null; returns 1 for the valid membershipId over the same seed", async () => {
    const { registered } = makeAdapter(SEED);
    const zero = await registered.countPending("org-1", "user-1", null);
    const one = await registered.countPending("org-1", "user-1", 10);
    expect(zero).toBe(0);
    expect(one).toBe(1);
  });
});

describe("SupportAttentionAdapter — countPending", () => {
  it("countPending returns exactly the number of items fetch returns for the same predicate and seed", async () => {
    const rows = [
      makeTicketRow({ id: 1, created_at: new Date("2026-09-01T10:00:00Z") }),
      makeTicketRow({ id: 2, created_at: new Date("2026-09-02T10:00:00Z") }),
      makeTicketRow({ id: 3, created_at: new Date("2026-09-03T10:00:00Z") }),
    ];
    const { registered } = makeAdapter(rows);
    const items = await registered.fetch("org-1", "user-1", 10, 25, null);
    const count = await registered.countPending("org-1", "user-1", 10);
    expect(count).toBe(items.length);
    expect(count).toBe(3);
  });
});

describe("SupportAttentionAdapter — cursor", () => {
  it("second page resumes after the last item of page 1 and contains no repeated row", async () => {
    const T1 = new Date("2026-09-01T08:00:00Z");
    const T2 = new Date("2026-09-01T09:00:00Z");
    const T3 = new Date("2026-09-01T10:00:00Z");
    const rows = [
      makeTicketRow({ id: 3, created_at: T1 }),
      makeTicketRow({ id: 7, created_at: T2 }),
      makeTicketRow({ id: 10, created_at: T3 }),
    ];
    const { registered } = makeAdapter(rows);

    const page1 = await registered.fetch("org-1", "user-1", 10, 2, null);
    expect(page1).toHaveLength(2);

    const lastItem = page1[page1.length - 1]!;
    const cursor: InboxSourcePosition = { id: Number(lastItem.id), t: lastItem.timestamp };

    const page2 = await registered.fetch("org-1", "user-1", 10, 2, cursor);
    expect(page2).toHaveLength(1);

    const page1Ids = new Set(page1.map((i) => i.id));
    for (const item of page2) {
      expect(page1Ids.has(item.id)).toBe(false);
    }
  });
});
