import { NotFoundException } from "@nestjs/common";
import { broadcastReadReceipts } from "../../../db/schema";
import { AnnouncementsService } from "./announcements.service";
import {
  type Op,
  makeCache,
  makeDb,
  walk,
} from "./__tests__/announcements-broadcast-double";

describe("AnnouncementsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  const ANN = {
    id: 1,
    orgId: OWNER,
    title: "Hello",
    message: "Body of the notice",
    audience: {
      type: "all",
      orgAnnouncement: { targetType: "ALL", targetIds: [], attachmentUrls: [] },
    },
    status: "SENT",
    scheduledAt: null,
    expiresAt: null,
    isPinned: false,
    createdBy: "user-owner",
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-09-01T10:00:00.000Z"),
  };

  function serviceOver(rows: unknown[]) {
    const ops: Op[] = [];
    const cache = makeCache();
    const db = makeDb((op) => {
      if (op.kind === "select" && op.table === broadcastReadReceipts) return [];
      return rows;
    }, ops);
    return { svc: new AnnouncementsService(db, cache as never), ops };
  }

  it("list returns empty for a different org (cross-tenant isolation)", async () => {
    const { svc, ops } = serviceOver([]);

    const result = await svc.list(ATTACKER);

    expect(result).toHaveLength(0);
    const predicate = walk(ops.map((op) => op.where));
    expect(predicate.values).toContain(ATTACKER);
    expect(predicate.values).not.toContain(OWNER);
  });

  it("list returns announcements for the owning org (control)", async () => {
    const { svc } = serviceOver([ANN]);

    const result = await svc.list(OWNER);

    expect(result).toHaveLength(1);
    expect(result[0]?.orgId).toBe(OWNER);
  });

  it("listAll stays inside the caller's org as well, because it drops the status filter and nothing else", async () => {
    const { svc, ops } = serviceOver([]);

    await svc.listAll(ATTACKER);

    const predicate = walk(ops.map((op) => op.where));
    expect(predicate.values).toContain(ATTACKER);
    expect(predicate.values).not.toContain(OWNER);
  });

  it("markRead refuses an announcement owned by another org, and writes nothing", async () => {
    const { svc, ops } = serviceOver([]);

    await expect(svc.markRead(ATTACKER, ANN.id, 5)).rejects.toThrow(
      NotFoundException,
    );

    expect(ops.some((op) => op.kind === "insert")).toBe(false);
    const predicate = walk(ops.map((op) => op.where));
    expect(predicate.values).toContain(ATTACKER);
    expect(predicate.values).toContain(ANN.id);
  });

  it("markRead accepts the owning org and stamps org_id so the composite foreign key engages", async () => {
    const { svc, ops } = serviceOver([{ id: ANN.id }]);

    await svc.markRead(OWNER, ANN.id, 5);

    const receipt = ops.find(
      (op) => op.kind === "insert" && op.table === broadcastReadReceipts,
    );
    expect(receipt?.values).toEqual({
      orgId: OWNER,
      broadcastId: ANN.id,
      membershipId: 5,
    });
  });

  it("read counts are gathered per org, so one tenant's dismissals never inflate another's readCount", async () => {
    const { svc, ops } = serviceOver([ANN]);

    await svc.list(OWNER);

    const counts = ops.find(
      (op) => op.kind === "select" && op.table === broadcastReadReceipts,
    );
    expect(counts).toBeDefined();
    expect(walk(counts?.where).values).toContain(OWNER);
  });
});
