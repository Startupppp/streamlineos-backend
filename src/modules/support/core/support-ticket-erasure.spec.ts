import type { TenantTx } from "../../../db/drizzle.types";
import {
  ERASED_REQUESTER_NAME,
  SUPPORT_ERASURE_PAGE,
  anonymiseSubjectSupportTickets,
  erasedRequesterEmail,
} from "./support-ticket-erasure";

const ORG_ID = "org-1";
const SUBJECT_ID = "user-subject";
const SUBJECT_EMAIL = "Subject@Example.com";

interface Harness {
  tx: TenantTx;
  selectCalls: number;
  updateSets: Array<Record<string, unknown>>;
  deletedTicketIds: number[][];
  updatedTicketIds: number[][];
}

function buildHarness(ticketIds: number[], subjectEmail: string | null = SUBJECT_EMAIL): Harness {
  const harness: Partial<Harness> = {
    selectCalls: 0,
    updateSets: [],
    deletedTicketIds: [],
    updatedTicketIds: [],
  };

  const remaining = [...ticketIds];
  let userRead = false;

  const select = jest.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.from = jest.fn().mockReturnValue(chain);
    chain.where = jest.fn().mockReturnValue(chain);
    chain.orderBy = jest.fn().mockReturnValue(chain);
    chain.limit = jest.fn().mockImplementation((limit: number) => {
      if (!userRead) {
        userRead = true;
        return Promise.resolve(subjectEmail === null ? [] : [{ email: subjectEmail }]);
      }
      harness.selectCalls = (harness.selectCalls ?? 0) + 1;
      return Promise.resolve(remaining.splice(0, limit).map((id) => ({ id })));
    });
    return chain;
  });

  const capturedUpdateIds: number[][] = harness.updatedTicketIds as number[][];
  const capturedDeleteIds: number[][] = harness.deletedTicketIds as number[][];

  const update = jest.fn(() => ({
    set: jest.fn((values: Record<string, unknown>) => {
      (harness.updateSets as Array<Record<string, unknown>>).push(values);
      return {
        where: jest.fn(() => ({
          returning: jest.fn(() => {
            const ids = pendingUpdateIds.shift() ?? [];
            capturedUpdateIds.push(ids);
            return Promise.resolve(ids.map((id) => ({ id })));
          }),
        })),
      };
    }),
  }));

  const del = jest.fn(() => ({
    where: jest.fn(() => ({
      returning: jest.fn(() => {
        const ids = pendingDeleteIds.shift() ?? [];
        capturedDeleteIds.push(ids);
        return Promise.resolve(ids.map((id) => ({ id })));
      }),
    })),
  }));

  const pages: number[][] = [];
  for (let i = 0; i < ticketIds.length; i += SUPPORT_ERASURE_PAGE) {
    pages.push(ticketIds.slice(i, i + SUPPORT_ERASURE_PAGE));
  }
  const pendingUpdateIds = pages.map((page) => [...page]);
  const pendingDeleteIds = pages.map((page) => [...page]);

  harness.tx = { select, update, delete: del } as unknown as TenantTx;
  return harness as Harness;
}

describe("anonymiseSubjectSupportTickets", () => {
  it("drains every page when the subject raised more tickets than the page size", async () => {
    const ticketIds = new Array(SUPPORT_ERASURE_PAGE * 2 + 37)
      .fill(null)
      .map((_, i) => i + 1);
    const harness = buildHarness(ticketIds);

    const result = await anonymiseSubjectSupportTickets(harness.tx, {
      orgId: ORG_ID,
      subjectUserId: SUBJECT_ID,
    });

    expect(harness.selectCalls).toBe(3);
    expect(result.ticketsAnonymised).toBe(ticketIds.length);
    expect(result.embeddingsDeleted).toBe(ticketIds.length);
  });

  it("replaces both requester columns with the erased sentinel", async () => {
    const harness = buildHarness([1, 2, 3]);

    await anonymiseSubjectSupportTickets(harness.tx, {
      orgId: ORG_ID,
      subjectUserId: SUBJECT_ID,
    });

    expect(harness.updateSets).toEqual([
      {
        requesterEmail: erasedRequesterEmail(SUBJECT_ID),
        requesterName: ERASED_REQUESTER_NAME,
      },
    ]);
  });

  it("deletes the ticket embedding for every anonymised ticket", async () => {
    const ticketIds = new Array(SUPPORT_ERASURE_PAGE + 5).fill(null).map((_, i) => i + 1);
    const harness = buildHarness(ticketIds);

    const result = await anonymiseSubjectSupportTickets(harness.tx, {
      orgId: ORG_ID,
      subjectUserId: SUBJECT_ID,
    });

    expect(harness.deletedTicketIds.flat()).toEqual(ticketIds);
    expect(result.embeddingsDeleted).toBe(ticketIds.length);
  });

  it("does nothing when the subject has no email to match on", async () => {
    const harness = buildHarness([1, 2, 3], null);

    const result = await anonymiseSubjectSupportTickets(harness.tx, {
      orgId: ORG_ID,
      subjectUserId: SUBJECT_ID,
    });

    expect(result).toEqual({ ticketsAnonymised: 0, embeddingsDeleted: 0 });
    expect(harness.selectCalls).toBe(0);
  });

  it("is a no-op on a re-run once the identity is already the erased sentinel", async () => {
    const harness = buildHarness([1, 2, 3], erasedRequesterEmail(SUBJECT_ID));

    const result = await anonymiseSubjectSupportTickets(harness.tx, {
      orgId: ORG_ID,
      subjectUserId: SUBJECT_ID,
    });

    expect(result).toEqual({ ticketsAnonymised: 0, embeddingsDeleted: 0 });
    expect(harness.selectCalls).toBe(0);
  });

  it("returns zero when the subject raised no tickets", async () => {
    const harness = buildHarness([]);

    const result = await anonymiseSubjectSupportTickets(harness.tx, {
      orgId: ORG_ID,
      subjectUserId: SUBJECT_ID,
    });

    expect(result).toEqual({ ticketsAnonymised: 0, embeddingsDeleted: 0 });
    expect(harness.selectCalls).toBe(1);
  });
});
