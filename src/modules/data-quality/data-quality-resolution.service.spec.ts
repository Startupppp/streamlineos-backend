import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.types";
import type { PartyMergeService } from "../party/party-merge.service";
import type { DataQualityQueueService } from "./data-quality-queue.service";
import { DataQualityResolutionService } from "./data-quality-resolution.service";
import type { DataQualityHealthService } from "./dataset-health.service";

/**
 * A Drizzle chain that answers with a scripted result.
 *
 * Every method returns the same object and the object is thenable, so
 * `db.update(t).set(v).where(c).returning(p)` resolves to whatever was queued —
 * which is enough to assert the shape of the traffic without a database.
 */
function chain(result: unknown[]): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then")
          return (resolve: (value: unknown[]) => void) => resolve(result);
        if (typeof property === "symbol") return undefined;
        return () => proxy;
      },
    },
  );
  return proxy;
}

/**
 * Counts statements as well as answering them.
 *
 * The count is the assertion that matters here: the ticket's fourth criterion is
 * that a bulk resolution is one decision rather than four hundred, and the only
 * way to hold that honestly is to fail the test when the statement count grows
 * with the size of the selection.
 */
class FakeDb {
  readonly calls: string[] = [];
  private readonly scripted: Record<string, unknown[][]> = { insert: [], update: [], select: [] };

  script(method: "insert" | "update" | "select", ...results: unknown[][]) {
    this.scripted[method]?.push(...results);
    return this;
  }

  private next(method: string): unknown[] {
    this.calls.push(method);
    return this.scripted[method]?.shift() ?? [];
  }

  insert() {
    return chain(this.next("insert"));
  }

  update() {
    return chain(this.next("update"));
  }

  select() {
    return chain(this.next("select"));
  }

  count(method: string): number {
    return this.calls.filter((call) => call === method).length;
  }

  asDb(): Db {
    // The service touches only these three verbs; anything else is a test bug
    // rather than a gap in the fake, and would fail loudly.
    return this as unknown as Db;
  }
}

const party = (partyId: string, patch: Record<string, unknown> = {}) => ({
  partyId,
  name: `Party ${partyId}`,
  legalName: null,
  email: `${partyId}@example.com`,
  phone: null,
  taxNumber: null,
  website: null,
  ...patch,
});

interface Candidate {
  findingId: string;
  proposedAction: string;
  reversibility: string;
  partyId: string;
  relatedPartyId: string | null;
  groupKey: string;
}

const candidate = (findingId: string, patch: Partial<Candidate> = {}): Candidate => ({
  findingId,
  proposedAction: "none",
  reversibility: "instant",
  partyId: `p-${findingId}`,
  relatedPartyId: null,
  groupKey: "staleness:180d+",
  ...patch,
});

describe("DataQualityResolutionService", () => {
  let db: FakeDb;
  let queue: { selectCandidates: jest.Mock; countOpenInGroup: jest.Mock };
  let merges: { merge: jest.Mock; revert: jest.Mock };
  let health: { captureQuietly: jest.Mock };
  let service: DataQualityResolutionService;

  const build = () => {
    service = new DataQualityResolutionService(
      db.asDb(),
      queue as unknown as DataQualityQueueService,
      merges as unknown as PartyMergeService,
      health as unknown as DataQualityHealthService,
    );
  };

  beforeEach(() => {
    db = new FakeDb();
    queue = { selectCandidates: jest.fn(), countOpenInGroup: jest.fn().mockResolvedValue(12) };
    merges = { merge: jest.fn(), revert: jest.fn() };
    health = { captureQuietly: jest.fn().mockResolvedValue(undefined) };
    build();
  });

  describe("resolve", () => {
    it("records four hundred findings as ONE decision and ONE claim", async () => {
      const candidates = Array.from({ length: 400 }, (_, i) => candidate(`f-${i}`));
      queue.selectCandidates.mockResolvedValue(candidates);
      db.script("insert", [{ resolutionId: "r-1" }]);
      db.script("update", candidates.map((row) => ({ ...row })), []);

      const result = await service.resolve("org_1", "user_1", {
        selection: { kind: "group", groupKey: "staleness:180d+" },
        action: "dismiss",
      });

      expect(result.resolvedCount).toBe(400);
      expect(db.count("insert")).toBe(1);
      // The claim, and the one row that carries the final counts. Not 400.
      expect(db.count("update")).toBe(2);
    });

    it("says how much of the group it did not reach", async () => {
      queue.selectCandidates.mockResolvedValue([candidate("f-1")]);
      db.script("insert", [{ resolutionId: "r-1" }]);
      db.script("update", [{ findingId: "f-1", proposedAction: "none" }], []);

      const result = await service.resolve("org_1", "user_1", {
        selection: { kind: "group", groupKey: "staleness:180d+" },
        action: "dismiss",
      });

      expect(result.remainingInGroup).toBe(12);
    });

    it("does not touch a record when the decision is a dismissal", async () => {
      queue.selectCandidates.mockResolvedValue([
        candidate("f-1", { proposedAction: "merge-parties", relatedPartyId: "p-2" }),
      ]);
      db.script("insert", [{ resolutionId: "r-1" }]);
      db.script("update", [{ findingId: "f-1", proposedAction: "merge-parties" }], []);

      const result = await service.resolve("org_1", "user_1", {
        selection: { kind: "ids", findingIds: ["f-1"] },
        action: "dismiss",
      });

      expect(merges.merge).not.toHaveBeenCalled();
      // Instantly reversible however irreversible the action it declined was.
      expect(result.reversibility).toBe("instant");
    });

    /**
     * The savepoint's whole reason for existing. One unmergeable pair must not
     * discard the other successes — a bulk decision that is all-or-nothing is a
     * bulk decision nobody dares take.
     */
    it("keeps the other items when one remediation fails", async () => {
      const rows = [
        candidate("f-1", { proposedAction: "merge-parties", relatedPartyId: "q-1" }),
        candidate("f-2", { proposedAction: "merge-parties", relatedPartyId: "q-2" }),
        candidate("f-3", { proposedAction: "merge-parties", relatedPartyId: "q-3" }),
      ];
      queue.selectCandidates.mockResolvedValue(rows);
      db.script("insert", [{ resolutionId: "r-1" }]);
      db.script(
        "update",
        rows.map((row) => ({ ...row })),
      );
      // Two clean pairs, then one that now contradicts itself.
      db.script(
        "select",
        [party("p-f-1"), party("q-1")],
        [party("p-f-2"), party("q-2")],
        [party("p-f-3", { taxNumber: "AAA" }), party("q-3", { taxNumber: "BBB" })],
      );
      merges.merge.mockResolvedValue({
        partyMergeId: "m-1",
        survivorPartyId: "s",
        mergedPartyId: "m",
      });

      const result = await service.resolve("org_1", "user_1", {
        selection: { kind: "ids", findingIds: ["f-1", "f-2", "f-3"] },
        action: "apply",
      });

      expect(merges.merge).toHaveBeenCalledTimes(2);
      expect(result.resolvedCount).toBe(2);
      expect(result.failedCount).toBe(1);
      expect(result.failures[0]).toMatchObject({ findingId: "f-3" });
      expect(result.failures[0]?.error).toMatch(/contradict/);
    });

    /**
     * The same scorer, not a second opinion. A finding is filed once and applied
     * later, and a pair that has since gained different tax numbers is exactly
     * the false merge `party-duplicates` is weighted to avoid.
     */
    it("refuses a merge the records now contradict", async () => {
      queue.selectCandidates.mockResolvedValue([
        candidate("f-1", { proposedAction: "merge-parties", relatedPartyId: "q-1" }),
      ]);
      db.script("insert", [{ resolutionId: "r-1" }]);
      db.script("update", [{ findingId: "f-1", proposedAction: "merge-parties", partyId: "p-f-1", relatedPartyId: "q-1" }]);
      db.script("select", [
        party("p-f-1", { taxNumber: "GB123" }),
        party("q-1", { taxNumber: "GB999" }),
      ]);

      const result = await service.resolve("org_1", "user_1", {
        selection: { kind: "ids", findingIds: ["f-1"] },
        action: "apply",
      });

      expect(merges.merge).not.toHaveBeenCalled();
      expect(result.failedCount).toBe(1);
    });

    it("fails the item rather than the batch when a record has gone", async () => {
      queue.selectCandidates.mockResolvedValue([
        candidate("f-1", { proposedAction: "merge-parties", relatedPartyId: "q-1" }),
      ]);
      db.script("insert", [{ resolutionId: "r-1" }]);
      db.script("update", [{ findingId: "f-1", proposedAction: "merge-parties", partyId: "p-f-1", relatedPartyId: "q-1" }]);
      db.script("select", [party("p-f-1")]);

      const result = await service.resolve("org_1", "user_1", {
        selection: { kind: "ids", findingIds: ["f-1"] },
        action: "apply",
      });

      expect(result.failures[0]?.error).toMatch(/no longer exists/);
    });

    it("inherits the strictest reversibility in the selection", async () => {
      queue.selectCandidates.mockResolvedValue([
        candidate("f-1", { reversibility: "instant" }),
        candidate("f-2", { reversibility: "irreversible" }),
      ]);
      db.script("insert", [{ resolutionId: "r-1" }]);
      db.script("update", [{ findingId: "f-1", proposedAction: "none" }], []);

      const result = await service.resolve("org_1", "user_1", {
        selection: { kind: "ids", findingIds: ["f-1", "f-2"] },
        action: "apply",
      });

      expect(result.reversibility).toBe("irreversible");
    });

    /**
     * The hazard a bulk action exists to create: the set moved between the screen
     * and the click. Checked before anything is written.
     */
    it("refuses, writing nothing, when the selection is not the size the caller expected", async () => {
      queue.selectCandidates.mockResolvedValue([candidate("f-1"), candidate("f-2")]);

      await expect(
        service.resolve("org_1", "user_1", {
          selection: { kind: "group", groupKey: "staleness:180d+" },
          action: "dismiss",
          expectedCount: 412,
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(db.count("insert")).toBe(0);
      expect(db.count("update")).toBe(0);
    });

    it("is not found when nothing open matches — including another tenant's identifiers", async () => {
      queue.selectCandidates.mockResolvedValue([]);

      await expect(
        service.resolve("org_1", "user_1", {
          selection: { kind: "ids", findingIds: ["someone-elses-finding"] },
          action: "dismiss",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("reverse", () => {
    const resolution = (patch: Record<string, unknown> = {}) => ({
      resolutionId: "r-1",
      action: "apply",
      reversibility: "instant",
      holdUntil: null,
      reversedAt: null,
      resolvedCount: 3,
      ...patch,
    });

    it("records merge-backed findings as failures since revert is not supported", async () => {
      db.script("select", [resolution()]);
      db.script("update", [{ resolutionId: "r-1" }]);
      db.script("select", [
        { findingId: "f-1", undoToken: { partyMergeId: "m-1" } },
        { findingId: "f-2", undoToken: { partyMergeId: "m-2" } },
      ]);
      db.script("update", []);

      const result = await service.reverse("org_1", "user_1", "r-1", {});

      expect(merges.revert).not.toHaveBeenCalled();
      expect(result.reopened).toBe(0);
      expect(result.failedCount).toBe(2);
    });

    it("refuses an irreversible decision without touching anything", async () => {
      db.script("select", [resolution({ reversibility: "irreversible" })]);

      await expect(service.reverse("org_1", "user_1", "r-1", {})).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(db.count("update")).toBe(0);
      expect(merges.revert).not.toHaveBeenCalled();
    });

    it("refuses a hold whose window has closed", async () => {
      db.script(
        "select",
        [resolution({ reversibility: "hold", holdUntil: new Date(Date.now() - 1000) })],
      );

      await expect(service.reverse("org_1", "user_1", "r-1", {})).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it("is not found for another tenant's decision", async () => {
      db.script("select", []);

      await expect(service.reverse("org_1", "user_1", "r-1", {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    /**
     * Two people clicking undo at the same instant. The second update matches no
     * row because `reversed_at IS NULL` is in its predicate, so it conflicts
     * rather than reverting four hundred merges twice.
     */
    it("refuses when somebody else reversed it a moment earlier", async () => {
      db.script("select", [resolution()]);
      db.script("update", []);

      await expect(service.reverse("org_1", "user_1", "r-1", {})).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    /**
     * A finding whose merge cannot be reverted stays closed: reopening it would
     * claim a record was restored when it was not. Since merge revert is not
     * implemented, every merge-backed finding becomes a failure.
     */
    it("reports all merge-backed findings as failures when revert is unavailable", async () => {
      db.script("select", [resolution()]);
      db.script("update", [{ resolutionId: "r-1" }]);
      db.script("select", [
        { findingId: "f-1", undoToken: { partyMergeId: "m-1" } },
        { findingId: "f-2", undoToken: { partyMergeId: "m-2" } },
      ]);
      db.script("update", []);

      const result = await service.reverse("org_1", "user_1", "r-1", {});

      expect(result.reopened).toBe(0);
      expect(result.failedCount).toBe(2);
    });
  });
});
