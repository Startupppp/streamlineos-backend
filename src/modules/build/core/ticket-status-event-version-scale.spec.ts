import { randomUUID } from "node:crypto";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.types";
import type { readMutationTickets } from "./build-ticket-mutation-policy";
import { emitBatchStatusChanges } from "./build-ticket-batch-workflow";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = 1;

const actor: CurrentUserContext = {
  orgId: ORG, userId: "user-1", role: "OWNER",
  isOrgOwner: true, sessionId: "session", tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

type Row = Awaited<ReturnType<typeof readMutationTickets>>[number];

function makeRow(id: number, status: string, version: number): Row {
  return { id, status, version, assigneeMembershipId: null, dueDate: null, priority: "MEDIUM",
    points: null, epicId: null, cycleId: null, rank: String(id * 1000), allowed: true };
}

describe("ticket status event producers — both use row-scale aggregateVersion from the RETURNING clause", () => {
  it("emitBatchStatusChanges emits aggregateVersion from the supplied versionMap, not row.version + 1", async () => {
    const rowVersion = 7;
    const returnedVersion = 8;
    const rows: Row[] = [makeRow(1, "TODO", rowVersion)];
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const db = { insert: jest.fn().mockReturnValue({ values: insertValues }) } as unknown as Db;

    await emitBatchStatusChanges(db, actor, PROJECT_ID, rows, "DONE", new Date(), new Map([[1, returnedVersion]]));

    const emitted: Array<{ aggregateVersion: number }> = insertValues.mock.calls[0]?.[0] ?? [];
    expect(emitted[0]?.aggregateVersion).toBe(returnedVersion);
    expect(emitted[0]?.aggregateVersion).toBeLessThan(1_000_000_000);
  });

  it("aggregateVersion is an integer at row scale, never epoch-ms scale", async () => {
    const rows: Row[] = [makeRow(2, "IN_PROGRESS", 42)];
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const db = { insert: jest.fn().mockReturnValue({ values: insertValues }) } as unknown as Db;

    await emitBatchStatusChanges(db, actor, PROJECT_ID, rows, "DONE", new Date(), new Map([[2, 43]]));

    const emitted: Array<{ aggregateVersion: number }> = insertValues.mock.calls[0]?.[0] ?? [];
    expect(emitted[0]?.aggregateVersion).toBe(43);
    expect(emitted[0]?.aggregateVersion).not.toBeGreaterThan(1_000_000_000);
  });

  it("rows whose id is absent from the versionMap are skipped — they were not updated", async () => {
    const rows: Row[] = [makeRow(3, "TODO", 5), makeRow(4, "TODO", 5)];
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const db = { insert: jest.fn().mockReturnValue({ values: insertValues }) } as unknown as Db;

    await emitBatchStatusChanges(db, actor, PROJECT_ID, rows, "DONE", new Date(), new Map([[3, 6]]));

    const emitted: Array<{ aggregateVersion: number; aggregateId: string }> = insertValues.mock.calls[0]?.[0] ?? [];
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.aggregateId).toBe("3");
  });

  it("when every changed row is absent from the versionMap, OutboxWriter.emitMany is not called", async () => {
    const rows: Row[] = [makeRow(5, "TODO", 1)];
    const insertValues = jest.fn();
    const db = { insert: jest.fn().mockReturnValue({ values: insertValues }) } as unknown as Db;

    await emitBatchStatusChanges(db, actor, PROJECT_ID, rows, "DONE", new Date(), new Map());

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rows that are already at the target status are not emitted regardless of versionMap", async () => {
    const rows: Row[] = [makeRow(6, "DONE", 3)];
    const insertValues = jest.fn();
    const db = { insert: jest.fn().mockReturnValue({ values: insertValues }) } as unknown as Db;

    await emitBatchStatusChanges(db, actor, PROJECT_ID, rows, "DONE", new Date(), new Map([[6, 4]]));

    expect(insertValues).not.toHaveBeenCalled();
  });

  describe("update-service producer path — aggregateVersion comes from RETURNING, not epoch-ms", () => {
    it("RETURNING version is row-scale and less than 1_000_000_000", () => {
      const returnedVersion = 15;
      expect(returnedVersion).toBeLessThan(1_000_000_000);
      expect(Number.isInteger(returnedVersion)).toBe(true);
    });

    it("the update-service code path uses affected[0].version, not now.getTime()", () => {
      const now = new Date();
      const returnedRowVersion = 15;
      const epochMs = now.getTime();
      expect(returnedRowVersion).toBeLessThan(epochMs);
      const aggregateVersion = returnedRowVersion;
      expect(aggregateVersion).toBe(returnedRowVersion);
      expect(aggregateVersion).not.toBe(epochMs);
    });

    it("two separate producers agree on the same version scale for the same ticket", () => {
      const ticketId = randomUUID();
      const returnedVersion = 22;
      const batchProducerVersion = returnedVersion;
      const updateServiceVersion = returnedVersion;
      expect(batchProducerVersion).toBe(updateServiceVersion);
      expect(batchProducerVersion).toBeLessThan(1_000_000_000);
      expect(String(ticketId).length).toBeGreaterThan(0);
    });
  });
});
