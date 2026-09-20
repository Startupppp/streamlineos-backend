import { ScopedRead } from "../../access/scoped-read";
import type { Db } from "../../../db/drizzle.module";
import { SignEnvelopeQueriesService } from "../sign-envelope-queries.service";
import type { SignRecipientsService } from "../sign-recipients.service";
import type { ListEnvelopesInput } from "../dto/e-sign.schemas";

const ORG = "org-list-window";
const MEMBER_ID = 5;

function makeRow(id: number, windowTotal: string) {
  return {
    id,
    orgId: ORG,
    title: `Envelope ${id}`,
    subject: null,
    message: null,
    status: "draft" as const,
    routingMode: "parallel" as const,
    ccTiming: "on_complete" as const,
    allowDecline: true,
    sourceModule: null,
    sourceEntityType: null,
    sourceEntityId: null,
    templateId: null,
    watermarkPolicyId: null,
    senderMembershipId: MEMBER_ID,
    reminderEnabled: true,
    reminderFirstAfterDays: 3,
    reminderRepeatDays: 3,
    reminderMaxCount: 5,
    reminderSentCount: 0,
    lastReminderAt: null,
    expiresAt: null,
    sentAt: null,
    completedAt: null,
    voidedAt: null,
    voidedByMembershipId: null,
    voidReason: null,
    declinedAt: null,
    correctionRequiredAt: null,
    correctionReason: null,
    finalizationKey: null,
    finalizedAt: null,
    finalPdfFileKey: null,
    finalPdfHash: null,
    metadataJson: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    windowTotal,
  };
}

function makeSelectDb(resolvedRows: ReturnType<typeof makeRow>[]) {
  const selectSpy = jest.fn();
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockReturnValue(chain);
  chain.offset = jest.fn().mockResolvedValue(resolvedRows);
  selectSpy.mockReturnValue(chain);
  const db = {
    select: selectSpy,
    query: {
      signEnvelopes: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  } as unknown as Db;
  return { db, selectSpy };
}

const recipients = { listForEnvelope: jest.fn() } as unknown as SignRecipientsService;
const query = { page: 1, limit: 25 } as unknown as ListEnvelopesInput;

describe("SignEnvelopeQueriesService.list — window-function pagination", () => {
  it("derives the page total from count(*) OVER () in the same query so the predicate runs only once per page load", async () => {
    const { db, selectSpy } = makeSelectDb([makeRow(1, "9"), makeRow(2, "9")]);
    const svc = new SignEnvelopeQueriesService(db, recipients);

    const result = await svc.list(ScopedRead.of(ORG, "u-1", "all"), MEMBER_ID, query);

    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(result.total).toBe(9);
    expect(result.items).toHaveLength(2);
  });

  it("strips windowTotal from each item so the response shape matches the signEnvelopeRowSchema contract", async () => {
    const { db } = makeSelectDb([makeRow(3, "1")]);
    const svc = new SignEnvelopeQueriesService(db, recipients);

    const result = await svc.list(ScopedRead.of(ORG, "u-1", "all"), MEMBER_ID, query);

    expect(result.items[0]).not.toHaveProperty("windowTotal");
    expect(result.items[0]).toHaveProperty("id", 3);
  });

  it("reports total as 0 when the page is empty without issuing a separate count query", async () => {
    const { db, selectSpy } = makeSelectDb([]);
    const svc = new SignEnvelopeQueriesService(db, recipients);

    const result = await svc.list(ScopedRead.of(ORG, "u-1", "all"), MEMBER_ID, query);

    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(result.total).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it("returns an empty list immediately when ScopedRead is denied — no DB query issued", async () => {
    const { db, selectSpy } = makeSelectDb([]);
    const svc = new SignEnvelopeQueriesService(db, recipients);

    const result = await svc.list(ScopedRead.of(ORG, "u-1", "none"), MEMBER_ID, query);

    expect(selectSpy).not.toHaveBeenCalled();
    expect(result.total).toBe(0);
    expect(result.items).toHaveLength(0);
  });
});
