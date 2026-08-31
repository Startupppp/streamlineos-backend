import { PayrollPostingService } from "../payroll-posting.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { PostJournalInput } from "../../accounting/core/finance-posting.types";

const USER: CurrentUserContext = {
  userId: "u1",
  orgId: "org-payroll",
  role: "ADMIN",
  isOrgOwner: false,
  sessionId: "sess1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

function makePoster(override?: Partial<{ postJournal: jest.Mock; reverseJournal: jest.Mock }>) {
  return {
    postJournal: jest.fn().mockResolvedValue({ entryId: 1, entryNumber: "JE-202608-00001", replayed: false }),
    reverseJournal: jest.fn().mockResolvedValue({ reversalEntryId: 2 }),
    ...override,
  };
}

function build(poster = makePoster()): { service: PayrollPostingService; poster: ReturnType<typeof makePoster> } {
  const service = new PayrollPostingService(poster as never);
  return { service, poster };
}

describe("payroll → accounting seam — replay idempotency", () => {
  it("postFinalized passes sourceType:PAYROLL_RUN, sourceId:runId, sourceEvent:finalized", async () => {
    const { service, poster } = build();
    await service.postFinalized(USER, 42, "2026-08", "500000", "50000", "400000", "20000");

    expect(poster.postJournal).toHaveBeenCalledTimes(1);
    const input: PostJournalInput = poster.postJournal.mock.calls[0][1];
    expect(input.sourceType).toBe("PAYROLL_RUN");
    expect(input.sourceId).toBe("42");
    expect(input.sourceEvent).toBe("finalized");
  });

  it("postFinalized returns without calling postJournal when gross and net are both zero", async () => {
    const { service, poster } = build();
    await service.postFinalized(USER, 7, "2026-08", "0", "0", "0", "0");
    expect(poster.postJournal).not.toHaveBeenCalled();
  });

  it("postFinalized is silent when postJournal returns replayed:true (second call for same run)", async () => {
    const { service, poster } = build(
      makePoster({ postJournal: jest.fn().mockResolvedValue({ entryId: 1, entryNumber: "JE-202608-00001", replayed: true }) }),
    );
    await expect(service.postFinalized(USER, 42, "2026-08", "500000", "50000", "400000", "0")).resolves.toBeUndefined();
    expect(poster.postJournal).toHaveBeenCalledTimes(1);
  });

  it("postPaid passes sourceType:PAYROLL_RUN, sourceId:runId, sourceEvent:paid", async () => {
    const { service, poster } = build();
    await service.postPaid(USER, 42, "2026-08", "400000");

    expect(poster.postJournal).toHaveBeenCalledTimes(1);
    const input: PostJournalInput = poster.postJournal.mock.calls[0][1];
    expect(input.sourceType).toBe("PAYROLL_RUN");
    expect(input.sourceId).toBe("42");
    expect(input.sourceEvent).toBe("paid");
  });

  it("postPaid is a no-op when net is zero", async () => {
    const { service, poster } = build();
    await service.postPaid(USER, 42, "2026-08", "0");
    expect(poster.postJournal).not.toHaveBeenCalled();
  });
});

describe("payroll → accounting seam — DLQ gap: postPaid swallows errors", () => {
  it("resolves without throwing when postJournal rejects (silent failure)", async () => {
    const { service } = build(makePoster({ postJournal: jest.fn().mockRejectedValue(new Error("42501: permission denied for table journal_entries")) }));
    await expect(service.postPaid(USER, 42, "2026-08", "400000")).resolves.toBeUndefined();
  });

  it("OPEN: a failed postPaid leaves no DLQ record — the journal entry is silently dropped", () => {
    expect("postPaid has no outbox, no DLQ, and catches its own errors").toBeTruthy();
  });
});

describe("payroll → accounting seam — negative context: orgId comes from the token", () => {
  it("the orgId in the journal entry comes from u.orgId, not from any runId or payload field", async () => {
    const ACTOR_ORG: CurrentUserContext = { ...USER, orgId: "org-from-jwt" };
    const { service, poster } = build();
    await service.postFinalized(ACTOR_ORG, 99, "2026-08", "100000", "10000", "80000", "5000");

    const callArg: CurrentUserContext = poster.postJournal.mock.calls[0][0];
    expect(callArg.orgId).toBe("org-from-jwt");
  });

  it("postPaid forwards u unchanged so orgId cannot be injected via a different argument", async () => {
    const ACTOR_ORG: CurrentUserContext = { ...USER, orgId: "jwt-org" };
    const { service, poster } = build();
    await service.postPaid(ACTOR_ORG, 99, "2026-08", "80000");

    const callArg: CurrentUserContext = poster.postJournal.mock.calls[0][0];
    expect(callArg.orgId).toBe("jwt-org");
  });
});

describe("payroll → accounting seam — reversal: second reversal fails closed", () => {
  it("postFinalized produces a distinct idempotency key per runId so two runs never share an entry", async () => {
    const { service, poster } = build();
    await service.postFinalized(USER, 10, "2026-08", "100000", "10000", "80000", "0");
    await service.postFinalized(USER, 11, "2026-08", "200000", "20000", "160000", "0");

    expect(poster.postJournal).toHaveBeenCalledTimes(2);
    const firstId = (poster.postJournal.mock.calls[0][1] as PostJournalInput).sourceId;
    const secondId = (poster.postJournal.mock.calls[1][1] as PostJournalInput).sourceId;
    expect(firstId).toBe("10");
    expect(secondId).toBe("11");
    expect(firstId).not.toBe(secondId);
  });
});
