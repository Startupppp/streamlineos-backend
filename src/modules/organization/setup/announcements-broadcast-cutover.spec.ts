import {
  broadcastAudienceTargets,
  broadcasts,
  orgUnitMembers,
} from "../../../db/schema";
import { AnnouncementsService } from "./announcements.service";
import { DashboardAnnouncementsService } from "../../dashboard/dashboard-announcements.service";
import { BroadcastsService } from "../../notifications/broadcasts.service";
import { announcementResponseSchema } from "./dto/announcement-response.schema";
import {
  type Op,
  makeCache,
  makeDb,
  walk,
} from "./__tests__/announcements-broadcast-double";

const ORG = "org-a";
const AUTHOR = "user-author";
const NEW_ID = 11;

function insertedBroadcast(ops: Op[]): Record<string, unknown> {
  const op = ops.find((o) => o.kind === "insert" && o.table === broadcasts);
  const values = op?.values;
  return values !== null && typeof values === "object" && !Array.isArray(values)
    ? (values as Record<string, unknown>)
    : {};
}

function insertedTargets(ops: Op[]): Array<Record<string, unknown>> {
  const op = ops.find(
    (o) => o.kind === "insert" && o.table === broadcastAudienceTargets,
  );
  const rows = op?.values;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function serviceFor(branchMemberUserIds: string[] = []) {
  const ops: Op[] = [];
  const cache = makeCache();
  const db = makeDb((op) => {
    if (op.kind === "insert" && op.table === broadcasts) {
      const written = op.values;
      const audience =
        written !== null && typeof written === "object" && !Array.isArray(written)
          ? (written as Record<string, unknown>).audience
          : undefined;
      return [
        {
          id: NEW_ID,
          orgId: ORG,
          title: "All hands",
          message: "Friday 4pm in the main hall",
          audience,
          status: "SENT",
          scheduledAt: null,
          expiresAt: null,
          isPinned: false,
          createdBy: AUTHOR,
          createdAt: new Date("2026-09-01T10:00:00.000Z"),
          updatedAt: new Date("2026-09-01T10:00:00.000Z"),
        },
      ];
    }
    if (op.kind === "select" && op.table === orgUnitMembers) {
      return branchMemberUserIds.map((userId) => ({ userId }));
    }
    return [];
  }, ops);
  return { svc: new AnnouncementsService(db, cache as never), ops, cache };
}

function writeInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "All hands",
    content: "Friday 4pm in the main hall",
    targetType: "ALL" as const,
    status: "PUBLISHED" as const,
    isPinned: false,
    attachmentUrls: [] as string[],
    publishAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe("an announcement created on /org/announcements lands on the one table Home and the Inbox read", () => {
  it("writes targetType ALL as a SENT broadcast with audience_type all, which is exactly what the Home widget query filters on", async () => {
    const { svc, ops } = serviceFor();
    await svc.create(ORG, AUTHOR, [], writeInput());
    const written = insertedBroadcast(ops);

    const homeOps: Op[] = [];
    const home = new DashboardAnnouncementsService(
      makeDb(() => [], homeOps),
      makeCache() as never,
      { holds: jest.fn().mockResolvedValue(true) } as never,
    );
    await home.getActiveAnnouncements(ORG);

    const homePredicate = walk(homeOps.map((o) => o.where));
    expect(written.status).toBe("SENT");
    expect(written.audienceType).toBe("all");
    expect(homePredicate.values).toContain(written.status);
    expect(homePredicate.values).toContain(written.audienceType);
  });

  it("stamps sent_at and the SENT status the unified Inbox broadcast source requires, the regression this cutover fixes", async () => {
    const { svc, ops } = serviceFor();
    await svc.create(ORG, AUTHOR, [], writeInput());
    const written = insertedBroadcast(ops);

    const inboxOps: Op[] = [];
    const inbox = new BroadcastsService(
      makeDb(() => [], inboxOps),
      makeCache() as never,
      { log: jest.fn() } as never,
      { emit: jest.fn() } as never,
    );
    await inbox.listInboxPage(ORG, "user-reader", 20, null, 9);

    const inboxPredicate = walk(inboxOps.map((o) => o.where));
    expect(written.sentAt).toBeInstanceOf(Date);
    expect(inboxPredicate.values).toContain(written.status);
    expect(inboxPredicate.values).toContain(written.audienceType);
  });

  it("does not satisfy the Inbox status filter while it is still a DRAFT, the negative that stops the assertion above passing on any row at all", async () => {
    const { svc, ops } = serviceFor();
    await svc.create(ORG, AUTHOR, [], writeInput({ status: "DRAFT" }));
    const written = insertedBroadcast(ops);

    const inboxOps: Op[] = [];
    const inbox = new BroadcastsService(
      makeDb(() => [], inboxOps),
      makeCache() as never,
      { log: jest.fn() } as never,
      { emit: jest.fn() } as never,
    );
    await inbox.listInboxPage(ORG, "user-reader", 20, null, 9);

    expect(walk(inboxOps.map((o) => o.where)).values).not.toContain(written.status);
  });

  it("writes a DRAFT announcement as a DRAFT broadcast with no sent_at, the negative that makes the visibility assertions above mean something", async () => {
    const { svc, ops } = serviceFor();
    await svc.create(ORG, AUTHOR, [], writeInput({ status: "DRAFT" }));
    const written = insertedBroadcast(ops);

    expect(written.status).toBe("DRAFT");
    expect(written.sentAt).toBeNull();
  });

  it("stamps the orgAnnouncement marker so this surface can find its own rows again", async () => {
    const { svc, ops } = serviceFor();
    await svc.create(ORG, AUTHOR, [], writeInput());

    expect(insertedBroadcast(ops).audience).toEqual({
      type: "all",
      orgAnnouncement: { targetType: "ALL", targetIds: [], attachmentUrls: [] },
    });
  });

  it("invalidates the Home announcements cache key, because Home now serves this row from a cache the old table never filled", async () => {
    const { svc, cache } = serviceFor();
    await svc.create(ORG, AUTHOR, [], writeInput());

    expect(cache.invalidateForOrg).toHaveBeenCalledWith(
      ORG,
      `dashboard:announcements:${ORG}`,
    );
  });
});

describe("each announcement audience maps onto one broadcast audience_type and one target kind", () => {
  it("writes no audience target rows for ALL, so resolveAudienceFilter short-circuits to the whole org", async () => {
    const { svc, ops } = serviceFor();
    await svc.create(ORG, AUTHOR, [], writeInput());

    expect(insertedBroadcast(ops).audienceType).toBe("all");
    expect(insertedTargets(ops)).toHaveLength(0);
  });

  it("maps DEPARTMENT onto audience_type departments and DEPARTMENT target rows", async () => {
    const { svc, ops } = serviceFor();
    await svc.create(
      ORG,
      AUTHOR,
      ["dept-1", "dept-2"],
      writeInput({ targetType: "DEPARTMENT" }),
    );

    expect(insertedBroadcast(ops).audienceType).toBe("departments");
    expect(insertedTargets(ops)).toEqual([
      { orgId: ORG, broadcastId: NEW_ID, kind: "DEPARTMENT", targetId: "dept-1" },
      { orgId: ORG, broadcastId: NEW_ID, kind: "DEPARTMENT", targetId: "dept-2" },
    ]);
  });

  it("maps ROLE onto audience_type roles and ROLE target rows", async () => {
    const { svc, ops } = serviceFor();
    await svc.create(ORG, AUTHOR, ["3"], writeInput({ targetType: "ROLE" }));

    expect(insertedBroadcast(ops).audienceType).toBe("roles");
    expect(insertedTargets(ops)).toEqual([
      { orgId: ORG, broadcastId: NEW_ID, kind: "ROLE", targetId: "3" },
    ]);
  });

  it("maps BRANCH onto audience_type users by snapshotting branch members, because broadcast_audience_type has no BRANCH value", async () => {
    const { svc, ops } = serviceFor(["user-in-branch"]);
    await svc.create(ORG, AUTHOR, ["branch-1"], writeInput({ targetType: "BRANCH" }));

    expect(insertedBroadcast(ops).audienceType).toBe("users");
    expect(insertedTargets(ops)).toEqual([
      { orgId: ORG, broadcastId: NEW_ID, kind: "USER", targetId: "user-in-branch" },
    ]);
  });

  it("gives a BRANCH announcement no target row for a user outside the branch, the negative for the snapshot above", async () => {
    const { svc, ops } = serviceFor(["user-in-branch"]);
    await svc.create(ORG, AUTHOR, ["branch-1"], writeInput({ targetType: "BRANCH" }));

    const targetIds = insertedTargets(ops).map((row) => row.targetId);
    expect(targetIds).toContain("user-in-branch");
    expect(targetIds).not.toContain("user-elsewhere");
  });

  it("scopes the branch member lookup to the caller's org so a branch id from another tenant resolves to nobody", async () => {
    const { svc, ops } = serviceFor();
    await svc.create(ORG, AUTHOR, ["branch-1"], writeInput({ targetType: "BRANCH" }));

    const lookup = ops.find((o) => o.kind === "select" && o.table === orgUnitMembers);
    expect(lookup).toBeDefined();
    expect(walk(lookup?.where).values).toContain(ORG);
  });

  it("never writes a broadcast audience_type outside the four the enum declares", async () => {
    for (const targetType of ["ALL", "DEPARTMENT", "ROLE", "BRANCH"]) {
      const { svc, ops } = serviceFor(["user-in-branch"]);
      await svc.create(ORG, AUTHOR, ["x"], writeInput({ targetType }));
      expect(["all", "roles", "departments", "users"]).toContain(
        insertedBroadcast(ops).audienceType,
      );
    }
  });
});

describe("the /org/announcements response contract survives the move onto broadcasts", () => {
  it("returns every field announcementResponseSchema declares and nothing else", async () => {
    const { svc } = serviceFor();

    const created = await svc.create(
      ORG,
      AUTHOR,
      [],
      writeInput({ attachmentUrls: ["https://files.example/a.pdf"] }),
    );

    expect(announcementResponseSchema.safeParse(created).success).toBe(true);
    expect(created.attachmentUrls).toEqual(["https://files.example/a.pdf"]);
    expect(created.content).toBe("Friday 4pm in the main hall");
    expect(created.authorId).toBe(AUTHOR);
  });

  it("echoes the branch ids the client selected rather than the snapshotted user ids, so the edit form reopens on the right audience", async () => {
    const { svc } = serviceFor(["user-in-branch"]);

    const created = await svc.create(
      ORG,
      AUTHOR,
      ["branch-1"],
      writeInput({ targetType: "BRANCH" }),
    );

    expect(created.targetType).toBe("BRANCH");
    expect(created.targetIds).toEqual(["branch-1"]);
  });

  it("reports a SENT broadcast whose expiry has passed as EXPIRED, the status vocabulary the frontend contract pins", async () => {
    const ops: Op[] = [];
    const db = makeDb(
      () => [
        {
          id: 3,
          orgId: ORG,
          title: "Old notice",
          message: "Stale",
          audience: {
            type: "all",
            orgAnnouncement: { targetType: "ALL", targetIds: [], attachmentUrls: [] },
          },
          status: "SENT",
          scheduledAt: null,
          expiresAt: new Date("2020-01-01T00:00:00.000Z"),
          isPinned: false,
          createdBy: AUTHOR,
          createdAt: new Date("2019-12-01T00:00:00.000Z"),
          updatedAt: new Date("2019-12-01T00:00:00.000Z"),
        },
      ],
      ops,
    );
    const svc = new AnnouncementsService(db, makeCache() as never);

    const rows = await svc.listAll(ORG);

    expect(rows[0]?.status).toBe("EXPIRED");
    expect(announcementResponseSchema.safeParse(rows[0]).success).toBe(true);
  });
});
