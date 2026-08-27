import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { Db } from "../../db/drizzle.types";
import { activities } from "../../db/schema";
import { callAnalysisReleases } from "../../db/schema/crm/call-analysis";
import type { AccessService } from "../access/access.service";
import { CallAnalysisVisibilityService } from "./call-analysis-visibility.service";

/**
 * Releasing is the rep's decision and nobody else's, and that is what this
 * asserts about the service rather than about the pure rule.
 *
 * `call-analysis-visibility.spec.ts` already proves `canReleaseCallAnalysis`
 * answers correctly. What it cannot prove is that the service asks it, asks it
 * about the right person, and refuses before writing anything — the failure
 * being prevented here is a release route that validates and then inserts
 * regardless, which would let a manager mark a rep's call as shared by the rep.
 *
 * The double honours the predicates the service builds rather than returning
 * whatever it holds, because a double that answered every read with its first
 * row would report the org scoping working when it was not there at all.
 */

const ORG = "org-1";
const OTHER_ORG = "org-2";
const CALL = "act-1";
const REP = "user-rep";
const MANAGER = "user-manager";
const VERSION = 1;

const user = (userId: string, orgId = ORG): CurrentUserContext => ({
  userId,
  orgId,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
});

interface ActivityRow {
  organizationId: string;
  activityId: string;
  kind: string;
  actorKind: string;
  actorUserId: string | null;
  deletedAt: Date | null;
}

interface ReleaseRow {
  callAnalysisReleaseId: string;
  organizationId: string;
  activityId: string;
  analyzerVersion: number;
  releasedByUserId: string;
  note: string | null;
  releasedAt: Date;
  createdAt: Date;
}

/**
 * The bound values out of an `and(eq(...))` clause, in the order the service
 * wrote them. Only two node shapes are followed — a `SQL` with `queryChunks`,
 * and a bound `Param` — because walking anything else steps from a column onto
 * its table and back onto every column that table has.
 */
function paramValues(clause: unknown): unknown[] {
  const found: unknown[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record["queryChunks"])) {
      for (const chunk of record["queryChunks"]) walk(chunk);
      return;
    }
    if ("value" in record && "encoder" in record) found.push(record["value"]);
  };
  walk(clause);
  return found;
}

function makeDb(calls: ActivityRow[], releases: ReleaseRow[]) {
  const store = [...releases];

  const readCalls = (clause: unknown): ActivityRow[] => {
    const [orgId, activityId] = paramValues(clause);
    return calls.filter(
      (row) =>
        row.organizationId === orgId &&
        row.activityId === activityId &&
        row.kind === "call" &&
        row.deletedAt === null,
    );
  };

  const readReleases = (clause: unknown): ReleaseRow[] => {
    const [orgId, activityId, version] = paramValues(clause);
    return store.filter(
      (row) =>
        row.organizationId === orgId &&
        row.activityId === activityId &&
        row.analyzerVersion === version,
    );
  };

  const db = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation((table: unknown) => ({
        where: jest.fn().mockImplementation((clause: unknown) => {
          const rows: unknown[] =
            table === activities ? readCalls(clause) : readReleases(clause);
          return {
            limit: async () => rows,
            then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
          };
        }),
      })),
    })),
    insert: jest.fn().mockImplementation((table: unknown) => ({
      values: jest.fn().mockImplementation((row: Record<string, unknown>) => ({
        onConflictDoNothing: async () => {
          expect(table).toBe(callAnalysisReleases);
          // The unique index, emulated. Without it this double would happily
          // hold two releases for one call and the idempotence assertion below
          // would pass while the real table rejected the second write.
          const clash = store.some(
            (existing) =>
              existing.organizationId === row["organizationId"] &&
              existing.activityId === row["activityId"] &&
              existing.analyzerVersion === row["analyzerVersion"],
          );
          if (clash) return;
          store.push({
            callAnalysisReleaseId: `rel-${store.length + 1}`,
            organizationId: row["organizationId"] as string,
            activityId: row["activityId"] as string,
            analyzerVersion: row["analyzerVersion"] as number,
            releasedByUserId: row["releasedByUserId"] as string,
            note: (row["note"] as string | null) ?? null,
            releasedAt: new Date("2026-08-20T12:00:00.000Z"),
            createdAt: new Date("2026-08-20T12:00:00.000Z"),
          });
        },
      })),
    })),
  };

  return { db: db as unknown as Db, store };
}

const humanCall = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  organizationId: ORG,
  activityId: CALL,
  kind: "call",
  actorKind: "human",
  actorUserId: REP,
  deletedAt: null,
  ...over,
});

/**
 * `teamHolders` rather than a flag, so one fixture can hold a rep and a manager
 * at once. A single boolean would have forced the "manager reads it after the
 * rep releases it" test to build two services and release through the wrong one,
 * which is a test of the double rather than of the service.
 */
function service(calls: ActivityRow[], releases: ReleaseRow[], teamHolders: string[] = []) {
  const { db, store } = makeDb(calls, releases);
  const access = {
    holds: jest
      .fn()
      .mockImplementation(async (ctx: CurrentUserContext) => teamHolders.includes(ctx.userId)),
  };
  return {
    store,
    access,
    subject: new CallAnalysisVisibilityService(db, access as unknown as AccessService),
  };
}

describe("only the rep can release their own call analysis", () => {
  it("records the release when the rep asks", async () => {
    const { subject, store } = service([humanCall()], []);

    const outcome = await subject.release(user(REP), CALL, VERSION, "the pricing bit at the end");

    expect(outcome).toEqual({
      ok: true,
      releasedAt: new Date("2026-08-20T12:00:00.000Z"),
      alreadyReleased: false,
    });
    expect(store).toHaveLength(1);
    expect(store[0]).toMatchObject({
      organizationId: ORG,
      activityId: CALL,
      analyzerVersion: VERSION,
      releasedByUserId: REP,
      note: "the pricing bit at the end",
    });
  });

  /**
   * The failure this file exists for. A manager holds every CRM key including
   * `view-team`; if the service consulted a permission instead of the rep on the
   * call, this would succeed and the release row would name the manager as the
   * releaser — the rep's own control over their own call, exercised by somebody
   * else. Nothing may be written.
   */
  it("refuses a manager, and writes nothing", async () => {
    const { subject, store } = service([humanCall()], [], [MANAGER]);

    const outcome = await subject.release(user(MANAGER), CALL, VERSION, null);

    expect(outcome).toEqual({
      ok: false,
      reason: "not-your-call",
      note: "Only the person who was on the call can share its analysis.",
    });
    expect(store).toHaveLength(0);
  });

  /**
   * An adapter-delivered call is written with `actor_kind: 'system'` and no
   * user, so it has no rep — and therefore nobody who can release it. Reading
   * `actor_user_id` without checking the kind would let a stray value on a
   * system row stand in for a person.
   */
  it("refuses everybody on a call nobody is attributed to", async () => {
    const { subject, store } = service(
      [humanCall({ actorKind: "system", actorUserId: null })],
      [],
    );

    const outcome = await subject.release(user(REP), CALL, VERSION, null);

    expect(outcome).toMatchObject({ ok: false, reason: "not-your-call" });
    expect(store).toHaveLength(0);
  });

  it("reports a call on another organisation's timeline as not found", async () => {
    const { subject } = service([humanCall()], []);

    const outcome = await subject.release(user(REP, OTHER_ORG), CALL, VERSION, null);

    expect(outcome).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("reports a deleted call as not found rather than releasing it", async () => {
    const { subject } = service([humanCall({ deletedAt: new Date("2026-08-19T00:00:00Z") })], []);

    expect(await subject.release(user(REP), CALL, VERSION, null)).toMatchObject({
      ok: false,
      reason: "not-found",
    });
  });
});

describe("releasing twice", () => {
  /**
   * The first decision stands. If the insert overwrote, `released_at` would move
   * forward every time the rep opened the sharing control — which for a manager
   * who had already read the analysis would look like it was shared later than
   * it was, and would push the row back behind the window in any surface that
   * reasons from that timestamp.
   */
  it("keeps the original timestamp and says it was already shared", async () => {
    const { subject, store } = service([humanCall()], []);

    const first = await subject.release(user(REP), CALL, VERSION, "first");
    const second = await subject.release(user(REP), CALL, VERSION, "second");

    expect(first).toMatchObject({ ok: true, alreadyReleased: false });
    expect(second).toMatchObject({ ok: true, alreadyReleased: true });
    expect(store).toHaveLength(1);
    expect(store[0]!.note).toBe("first");
  });

  /**
   * A release is pinned to the analyser whose output the rep read. Version 2 is
   * a different judgement of the same call, and the rep's consent to version 1
   * does not cover it — so the second release is a new row, not a duplicate.
   */
  it("treats a release against a new analyser version as a new decision", async () => {
    const { subject, store } = service([humanCall()], []);

    await subject.release(user(REP), CALL, 1, null);
    const second = await subject.release(user(REP), CALL, 2, null);

    expect(second).toMatchObject({ ok: true, alreadyReleased: false });
    expect(store).toHaveLength(2);
  });
});

describe("the service asks the access layer who may read other people's calls", () => {
  /**
   * Wiring, not policy. The rule is proved in `call-analysis-visibility.spec.ts`;
   * what is proved here is that `decide` reaches it with a `canReadTeam` that
   * came from `AccessService` and a rep that came from the activity — a service
   * that hardcoded either would pass every test in that file and still show a
   * manager an embargoed analysis.
   */
  const ANALYSED_AT = new Date("2026-08-20T09:00:00.000Z");

  it("hides an embargoed analysis from a manager who holds the team key", async () => {
    const { subject, access } = service([humanCall()], [], [MANAGER]);
    jest.useFakeTimers().setSystemTime(new Date("2026-08-20T10:00:00.000Z"));

    try {
      const decision = await subject.decide(user(MANAGER), CALL, ANALYSED_AT, VERSION);

      expect(decision.visible).toBe(false);
      expect(decision.reason).toBe("rep-window");
      expect(access.holds).toHaveBeenCalledWith(
        expect.objectContaining({ userId: MANAGER }),
        "crm:call-analysis:view-team",
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("shows the rep their own analysis in the same instant", async () => {
    const { subject } = service([humanCall()], []);
    jest.useFakeTimers().setSystemTime(new Date("2026-08-20T10:00:00.000Z"));

    try {
      const decision = await subject.decide(user(REP), CALL, ANALYSED_AT, VERSION);
      expect(decision).toEqual({ visible: true, reason: "own-call", opensAt: null });
    } finally {
      jest.useRealTimers();
    }
  });

  it("opens it to the manager once the rep has released it", async () => {
    const { subject } = service([humanCall()], [], [MANAGER]);
    jest.useFakeTimers().setSystemTime(new Date("2026-08-20T10:00:00.000Z"));

    try {
      // Embargoed an hour after the analysis, with twenty-three hours to run.
      expect((await subject.decide(user(MANAGER), CALL, ANALYSED_AT, VERSION)).visible).toBe(false);

      await subject.release(user(REP), CALL, VERSION, null);

      // The double stamps every release at 12:00; read from after that.
      jest.setSystemTime(new Date("2026-08-20T12:30:00.000Z"));
      const decision = await subject.decide(user(MANAGER), CALL, ANALYSED_AT, VERSION);

      expect(decision).toEqual({ visible: true, reason: "released", opensAt: null });
    } finally {
      jest.useRealTimers();
    }
  });
});
