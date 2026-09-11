/**
 * The two things createJournalEntry decides before anything is written: does the
 * entry balance, and does it need an approval.
 *
 * Neutering the balance check to `if (false)` left all 197 accounting tests
 * green. The balance rule is defended three times over — the Zod refine at the
 * boundary, this check, and JournalPostingService.assertBalanced — but nothing
 * observed THIS one, and the approval routing beside it is defended nowhere
 * else at all.
 */
import { BadRequestException } from "@nestjs/common";
import {
  createJournalEntry,
  type JournalCreateDeps,
} from "./lib/journal-entry-create";
import type { Db } from "../../../db/drizzle.module";
import type { CreateJournalEntryInput } from "./dto/accounting.schemas";

const ORG = "org-1";
const USER = "user-1";
const MEMBERSHIP = 7;

function entry(
  lines: Array<{ accountCode: string; debit: number; credit: number }>,
): CreateJournalEntryInput {
  return {
    entryDate: "2026-09-01",
    description: "Manual entry",
    status: "DRAFT",
    lines,
  } as CreateJournalEntryInput;
}

const BALANCED = entry([
  { accountCode: "1000", debit: 100, credit: 0 },
  { accountCode: "4000", debit: 0, credit: 100 },
]);

function makeDeps(policies: unknown[]) {
  const approvalInserts: unknown[] = [];
  const statusUpdates: unknown[] = [];

  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(policies),
      }),
    }),
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          update: jest.fn().mockReturnValue({
            set: (values: unknown) => {
              statusUpdates.push(values);
              return { where: jest.fn().mockResolvedValue(undefined) };
            },
          }),
          insert: jest.fn().mockReturnValue({
            values: (values: unknown) => {
              approvalInserts.push(values);
              return Promise.resolve(undefined);
            },
          }),
        }),
      ),
  } as unknown as Db;

  const posting = {
    seedChartOfAccountsForOrg: jest.fn().mockResolvedValue(undefined),
    persistJournalEntry: jest
      .fn()
      .mockResolvedValue({ id: 501, entryNumber: "JE-501" }),
  };
  const finPosting = { assertPeriodOpen: jest.fn().mockResolvedValue(undefined) };
  const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn() };

  const deps: JournalCreateDeps = {
    db,
    posting: posting as never,
    finPosting: finPosting as never,
    audit: audit as never,
    dispatch: dispatch as never,
  };
  return { deps, posting, finPosting, dispatch, approvalInserts, statusUpdates };
}

describe("createJournalEntry — the balance invariant", () => {
  beforeEach(() => jest.clearAllMocks());

  it("refuses an entry whose debits and credits disagree", async () => {
    const { deps, posting } = makeDeps([]);
    await expect(
      createJournalEntry(
        deps,
        ORG,
        USER,
        MEMBERSHIP,
        entry([
          { accountCode: "1000", debit: 100, credit: 0 },
          { accountCode: "4000", debit: 0, credit: 90 },
        ]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(posting.persistJournalEntry).not.toHaveBeenCalled();
  });

  it("names both sides in the refusal so the caller can see the gap", async () => {
    const { deps } = makeDeps([]);
    await expect(
      createJournalEntry(
        deps,
        ORG,
        USER,
        MEMBERSHIP,
        entry([
          { accountCode: "1000", debit: 100, credit: 0 },
          { accountCode: "4000", debit: 0, credit: 90 },
        ]),
      ),
    ).rejects.toThrow(/debit 100\.00 != credit 90\.00/);
  });

  it("accepts float noise that rounds to the same paise", async () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE754. Comparing the floats
    // directly would reject this; rounding both sides to paise is the point.
    const { deps, posting } = makeDeps([]);
    await createJournalEntry(
      deps,
      ORG,
      USER,
      MEMBERSHIP,
      entry([
        { accountCode: "1000", debit: 0.1, credit: 0 },
        { accountCode: "1001", debit: 0.2, credit: 0 },
        { accountCode: "4000", debit: 0, credit: 0.3 },
      ]),
    );
    expect(posting.persistJournalEntry).toHaveBeenCalledTimes(1);
  });

  it("refuses a line carrying both a debit and a credit", async () => {
    // Deliberately BALANCED in aggregate (150 = 150), because the whole-entry
    // check runs first and would otherwise mask the per-line one.
    const { deps } = makeDeps([]);
    await expect(
      createJournalEntry(
        deps,
        ORG,
        USER,
        MEMBERSHIP,
        entry([
          { accountCode: "1000", debit: 100, credit: 100 },
          { accountCode: "4000", debit: 50, credit: 50 },
        ]),
      ),
    ).rejects.toThrow(/exactly one of debit or credit/);
  });

  it("refuses a line carrying neither", async () => {
    const { deps } = makeDeps([]);
    await expect(
      createJournalEntry(
        deps,
        ORG,
        USER,
        MEMBERSHIP,
        entry([
          { accountCode: "1000", debit: 0, credit: 0 },
          { accountCode: "4000", debit: 0, credit: 0 },
        ]),
      ),
    ).rejects.toThrow(/exactly one of debit or credit/);
  });

  it("checks the period is open before writing anything", async () => {
    const { deps, finPosting } = makeDeps([]);
    await createJournalEntry(deps, ORG, USER, MEMBERSHIP, BALANCED);
    expect(finPosting.assertPeriodOpen).toHaveBeenCalledWith(ORG, "2026-09-01");
  });
});

describe("createJournalEntry — the approval route", () => {
  beforeEach(() => jest.clearAllMocks());

  it("persists with the caller's status and opens no request when no policy applies", async () => {
    const { deps, posting, approvalInserts, statusUpdates, dispatch } = makeDeps([]);

    await createJournalEntry(deps, ORG, USER, MEMBERSHIP, BALANCED);

    expect(posting.persistJournalEntry.mock.calls[0]?.[0]).toMatchObject({
      status: "DRAFT",
      sourceType: "manual",
    });
    expect(approvalInserts).toHaveLength(0);
    expect(statusUpdates).toHaveLength(0);
    expect(dispatch.emit).not.toHaveBeenCalled();
  });

  it("routes an entry over the threshold to PENDING_APPROVAL with a request and a notice", async () => {
    const { deps, posting, approvalInserts, statusUpdates, dispatch } = makeDeps([
      { id: 9, approverUserId: "user-approver", minAmount: "50.0000" },
    ]);

    await createJournalEntry(deps, ORG, USER, MEMBERSHIP, BALANCED);

    // Persisted as DRAFT regardless of what the caller asked for...
    expect(posting.persistJournalEntry.mock.calls[0]?.[0]).toMatchObject({
      status: "DRAFT",
    });
    // ...then moved to PENDING_APPROVAL in the SAME transaction as the request,
    // so an entry can never sit in PENDING_APPROVAL with nothing to approve.
    expect(statusUpdates).toEqual([{ status: "PENDING_APPROVAL" }]);
    expect(approvalInserts).toHaveLength(1);
    expect(approvalInserts[0]).toMatchObject({
      orgId: ORG,
      recordType: "MANUAL_JOURNAL",
      recordId: 501,
      status: "PENDING",
      requestedBy: USER,
    });
    expect(dispatch.emit).toHaveBeenCalledTimes(1);
    expect(dispatch.emit.mock.calls[0]?.[0]).toMatchObject({
      eventKey: "accounting.approval.requested",
      targetUserIds: ["user-approver"],
    });
  });

  it("does not route an entry below the threshold", async () => {
    const { deps, approvalInserts, statusUpdates } = makeDeps([
      { id: 9, approverUserId: "user-approver", minAmount: "5000.0000" },
    ]);

    await createJournalEntry(deps, ORG, USER, MEMBERSHIP, BALANCED);

    expect(approvalInserts).toHaveLength(0);
    expect(statusUpdates).toHaveLength(0);
  });

  it("treats a policy with no minAmount as applying to every entry", async () => {
    const { deps, approvalInserts } = makeDeps([
      { id: 9, approverUserId: null, minAmount: null },
    ]);

    await createJournalEntry(deps, ORG, USER, MEMBERSHIP, BALANCED);

    expect(approvalInserts).toHaveLength(1);
  });
});
