jest.mock("./lead-party-reader", () => ({
  ...jest.requireActual("./lead-party-reader"),
  loadLeadView: jest.fn(),
}));

import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { LeadStatusService } from "./lead-status.service";
import { loadLeadView } from "./lead-party-reader";
import type { LeadView } from "./lead-party-reader";

const mockLoadLeadView = loadLeadView as jest.MockedFunction<typeof loadLeadView>;

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

const FAKE_LEAD: LeadView = {
  id: 21,
  partyId: "party-1",
  orgId: OWNER,
  name: "Test Lead",
  status: "NEW",
  priority: "WARM",
  source: "other",
  score: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

function makeService() {
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
          then: (res: (v: unknown[]) => unknown) => Promise.resolve([]).then(res),
        }),
        leftJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ then: (res: (v: unknown[]) => unknown) => Promise.resolve([]).then(res) }) }),
        innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ then: (res: (v: unknown[]) => unknown) => Promise.resolve([]).then(res) }) }),
      }),
    }),
    transaction: jest.fn().mockResolvedValue(undefined),
  } as unknown as Db;
  const cache = { invalidate: jest.fn(), invalidateNamespace: jest.fn(), cachedVersioned: jest.fn() };
  const audit = { log: jest.fn() };
  const crmMetadata = { getAggregate: jest.fn().mockResolvedValue({ options: [], stages: [] }) };
  const blueprints = { assertTransitionAllowed: jest.fn().mockResolvedValue({ allowed: true }) };
  const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
  const conversion = { convert: jest.fn() };
  return new LeadStatusService(db, cache as never, audit as never, crmMetadata as never, blueprints as never, planLimits as never, conversion as never);
}

describe("LeadStatusService — cross-tenant isolation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("throws 404 for a lead belonging to a different org (cross-tenant)", async () => {
    mockLoadLeadView.mockResolvedValue(undefined);
    const svc = makeService();
    await expect(svc.changeStatus(ATTACKER, "u1", 21, { status: "contacted" })).rejects.toThrow(NotFoundException);
  });

  it("throws 404 for a lead id that does not exist (unknown id)", async () => {
    mockLoadLeadView.mockResolvedValue(undefined);
    const svc = makeService();
    await expect(svc.changeStatus(OWNER, "u1", 9999, { status: "contacted" })).rejects.toThrow(NotFoundException);
  });

  it("returns stale_or_missing when the transaction race-conditions after a found load (own org)", async () => {
    mockLoadLeadView.mockResolvedValue(FAKE_LEAD);
    const svc = makeService();
    const result = await svc.changeStatus(OWNER, "u1", 21, { status: "contacted" });
    expect(result).toEqual({ ok: false, reason: "stale_or_missing" });
  });
});
