import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { broadcastReadReceipts, broadcasts } from "../../../db/schema";
import { AnnouncementsService } from "./announcements.service";
import {
  orgAnnouncementRowScope,
  orgAnnouncementScope,
} from "./org-announcement-broadcast";
import {
  type Op,
  makeCache,
  makeDb,
  walk,
} from "./__tests__/announcements-broadcast-double";

const ORG_A = "org-a";
const ORG_B = "org-b";
const AUTHOR = "user-author";
const MEMBERSHIP = 42;

const OWNED_ROW = {
  id: 7,
  orgId: ORG_A,
  title: "All hands",
  message: "Friday 4pm",
  audience: {
    type: "all",
    orgAnnouncement: { targetType: "ALL", targetIds: [], attachmentUrls: [] },
  },
  status: "SENT",
  scheduledAt: null,
  expiresAt: null,
  isPinned: false,
  createdBy: AUTHOR,
  createdAt: new Date("2026-09-01T10:00:00.000Z"),
  updatedAt: new Date("2026-09-01T10:00:00.000Z"),
};

function serviceOver(rows: unknown[]) {
  const ops: Op[] = [];
  const cache = makeCache();
  const db = makeDb((op) => {
    if (op.table === broadcastReadReceipts && op.kind === "select") return [];
    return rows;
  }, ops);
  return { svc: new AnnouncementsService(db, cache as never), ops, cache };
}

function writes(ops: Op[]) {
  return ops.filter((op) => op.kind === "update" || op.kind === "delete");
}

function patch() {
  return { title: "Edited title", content: "Edited content for the notice" };
}

describe("the row scope keeps hr:announcements:manage inside the rows this surface authored", () => {
  it("compiles to SQL that demands the orgAnnouncement marker alongside org_id and id", () => {
    const query = new PgDialect().sqlToQuery(orgAnnouncementRowScope(ORG_A, 7));

    expect(query.sql).toContain("'orgAnnouncement'");
    expect(query.sql).toContain("org_id");
    expect(query.sql).toContain('"broadcasts"."id"');
    expect(query.params).toEqual([ORG_A, 7]);
  });

  it("puts the same marker on the unscoped list predicate, so a listing cannot show an admin broadcast either", () => {
    const query = new PgDialect().sqlToQuery(orgAnnouncementScope());

    expect(query.sql).toContain("'orgAnnouncement'");
    expect(query.sql).toContain("audience");
  });
});

describe("hr:announcements:manage cannot reach a broadcast created on the admin Broadcasts surface", () => {
  it("refuses to update a broadcast that carries no orgAnnouncement marker and issues no write", async () => {
    const { svc, ops } = serviceOver([]);

    await expect(svc.update(ORG_A, 7, undefined, patch())).rejects.toThrow(
      NotFoundException,
    );
    expect(writes(ops)).toHaveLength(0);
  });

  it("updates a broadcast this surface authored, the positive control for the refusal above", async () => {
    const { svc, ops } = serviceOver([OWNED_ROW]);

    const updated = await svc.update(ORG_A, 7, undefined, patch());

    expect(updated.id).toBe(7);
    expect(ops.some((op) => op.kind === "update" && op.table === broadcasts)).toBe(true);
  });

  it("refuses to delete a broadcast that carries no orgAnnouncement marker", async () => {
    const { svc } = serviceOver([]);

    await expect(svc.remove(ORG_A, 7)).rejects.toThrow(NotFoundException);
  });

  it("deletes a broadcast this surface authored, the positive control for the refusal above", async () => {
    const { svc, ops } = serviceOver([{ id: 7 }]);

    await expect(svc.remove(ORG_A, 7)).resolves.toBeUndefined();
    expect(ops.some((op) => op.kind === "delete" && op.table === broadcasts)).toBe(true);
  });

  it("carries the marker on the delete statement itself, not only on a prior lookup", async () => {
    const { svc, ops } = serviceOver([{ id: 7 }]);
    await svc.remove(ORG_A, 7);

    const deletion = ops.find((op) => op.kind === "delete" && op.table === broadcasts);
    const sql = new PgDialect().sqlToQuery(
      orgAnnouncementRowScope(ORG_A, 7),
    ).sql;
    expect(deletion).toBeDefined();
    expect(new PgDialect().sqlToQuery(deletion?.where as never).sql).toBe(sql);
  });

  it("carries the marker on the update statement itself, so a concurrent rewrite cannot slip past the lookup", async () => {
    const { svc, ops } = serviceOver([OWNED_ROW]);
    await svc.update(ORG_A, 7, undefined, patch());

    const mutation = ops.find((op) => op.kind === "update" && op.table === broadcasts);
    expect(mutation).toBeDefined();
    expect(new PgDialect().sqlToQuery(mutation?.where as never).sql).toContain(
      "'orgAnnouncement'",
    );
  });
});

describe("an actor in org B cannot read, update or delete org A's announcement", () => {
  it("scopes the list read to the caller's org and never to the other tenant", async () => {
    const { svc, ops } = serviceOver([]);

    await svc.list(ORG_B);

    const predicate = walk(ops.map((op) => op.where));
    expect(predicate.values).toContain(ORG_B);
    expect(predicate.values).not.toContain(ORG_A);
  });

  it("returns org A's rows when org A asks, the positive control for the exclusion above", async () => {
    const { svc } = serviceOver([OWNED_ROW]);

    const rows = await svc.list(ORG_A);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBe(ORG_A);
  });

  it("refuses an update from org B on an id that exists in org A, as a 404 rather than a 403", async () => {
    const { svc, ops } = serviceOver([]);

    await expect(svc.update(ORG_B, 7, undefined, patch())).rejects.toThrow(
      NotFoundException,
    );
    const predicate = walk(ops.map((op) => op.where));
    expect(predicate.values).toContain(ORG_B);
    expect(predicate.values).not.toContain(ORG_A);
  });

  it("refuses a delete from org B on an id that exists in org A", async () => {
    const { svc, ops } = serviceOver([]);

    await expect(svc.remove(ORG_B, 7)).rejects.toThrow(NotFoundException);
    expect(walk(ops.map((op) => op.where)).values).not.toContain(ORG_A);
  });

  it("refuses a markRead from org B on an id that exists in org A and writes no receipt", async () => {
    const { svc, ops } = serviceOver([]);

    await expect(svc.markRead(ORG_B, 7, MEMBERSHIP)).rejects.toThrow(
      NotFoundException,
    );
    expect(ops.some((op) => op.kind === "insert")).toBe(false);
  });
});

describe("markRead records a dismissal receipt for the acting membership", () => {
  it("writes the receipt against the membership the session resolved, never a client-supplied user id", async () => {
    const { svc, ops } = serviceOver([{ id: 7 }]);

    await svc.markRead(ORG_A, 7, MEMBERSHIP);

    const receipt = ops.find(
      (op) => op.kind === "insert" && op.table === broadcastReadReceipts,
    );
    expect(receipt?.values).toEqual({
      orgId: ORG_A,
      broadcastId: 7,
      membershipId: MEMBERSHIP,
    });
  });

  it("is idempotent, because the insert defers to the org/broadcast/membership unique index", async () => {
    const { svc, ops } = serviceOver([{ id: 7 }]);

    await svc.markRead(ORG_A, 7, MEMBERSHIP);
    await svc.markRead(ORG_A, 7, MEMBERSHIP);

    const receipts = ops.filter(
      (op) => op.kind === "insert" && op.table === broadcastReadReceipts,
    );
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      const conflict = receipt.conflict as { target?: Array<{ name?: string }> };
      expect((conflict.target ?? []).map((column) => column.name)).toEqual([
        "org_id",
        "broadcast_id",
        "membership_id",
      ]);
    }
  });

  it("refuses a principal with no organization membership, because the receipt table is membership-keyed", async () => {
    const { svc, ops } = serviceOver([{ id: 7 }]);

    await expect(svc.markRead(ORG_A, 7, null)).rejects.toThrow(ForbiddenException);
    expect(ops).toHaveLength(0);
  });
});
