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

describe("ticket status event producers — both use row-scale aggregateVersion", () => {
  it("emitBatchStatusChanges emits aggregateVersion = row.version + 1, not a timestamp", async () => {
    const rowVersion = 7;
    const rows: Row[] = [makeRow(1, "TODO", rowVersion)];
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const db = { insert: jest.fn().mockReturnValue({ values: insertValues }) } as unknown as Db;

    await emitBatchStatusChanges(db, actor, PROJECT_ID, rows, "DONE", new Date());

    const emitted: Array<{ aggregateVersion: number }> = insertValues.mock.calls[0]?.[0] ?? [];
    expect(emitted[0]?.aggregateVersion).toBe(rowVersion + 1);
    expect(emitted[0]?.aggregateVersion).toBeLessThan(1_000_000_000);
  });

  it("emitBatchStatusChanges aggregateVersion is an integer close to row.version, never epoch-ms scale", async () => {
    const rows: Row[] = [makeRow(2, "IN_PROGRESS", 42)];
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const db = { insert: jest.fn().mockReturnValue({ values: insertValues }) } as unknown as Db;

    await emitBatchStatusChanges(db, actor, PROJECT_ID, rows, "DONE", new Date());

    const emitted: Array<{ aggregateVersion: number }> = insertValues.mock.calls[0]?.[0] ?? [];
    expect(emitted[0]?.aggregateVersion).toBe(43);
    expect(emitted[0]?.aggregateVersion).not.toBeGreaterThan(1_000_000_000);
  });
});
