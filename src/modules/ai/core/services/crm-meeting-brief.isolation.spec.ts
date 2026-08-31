jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
}));

jest.mock("./crm-brief-loaders", () => ({
  loadLeadProfile: jest.fn().mockResolvedValue(undefined),
  loadLeadContext: jest.fn().mockResolvedValue(undefined),
  trunc: (s: string | undefined | null) => s ?? "",
}));

import { NotFoundException } from "@nestjs/common";
import { CrmMeetingBriefService } from "./crm-meeting-brief.service";
import type { AiGatewayService } from "../gateway/ai-gateway.service";
import type { OrgFeaturesService } from "./org-features.service";
import type { Db } from "../../../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";

const ALL_FLAGS_ON = {
  aiLeadScoring: true,
  aiChat: false,
  aiEmailDraft: false,
  aiSmartNotifications: false,
  aiWeeklyRecap: false,
  supportAi: false,
};

function makeChain(resolved: unknown[]) {
  const promise = Promise.resolve(resolved);
  const chain: Record<string, unknown> = {};
  chain.from = jest.fn(() => chain);
  chain.innerJoin = jest.fn(() => chain);
  chain.leftJoin = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => promise);
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => promise.then(res, rej);
  chain.catch = (rej: (e: unknown) => unknown) => promise.catch(rej);
  chain.finally = (cb: () => void) => promise.finally(cb);
  return chain;
}

function makeDb(): Db {
  return {
    select: jest.fn(() => makeChain([])),
    query: {
      clientAccounts: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
  } as unknown as Db;
}

function makeOrgFeatures() {
  return { getFlags: jest.fn().mockResolvedValue(ALL_FLAGS_ON) } as unknown as OrgFeaturesService;
}

const mockGateway = {
  invokeText: jest.fn(),
} as unknown as AiGatewayService;

beforeEach(() => jest.resetAllMocks());

describe("CrmMeetingBriefService — cross-tenant isolation", () => {
  it("meetingPrep throws NotFoundException for a lead attendee belonging to a different org (DENY)", async () => {
    const db = makeDb();
    const svc = new CrmMeetingBriefService(db, mockGateway, makeOrgFeatures());
    await expect(
      svc.meetingPrep(ATTACKER_ORG, {
        meetingTitle: "Q4 Review",
        attendeeType: "lead",
        attendeeId: 42,
        scheduledAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it("meetingPrep throws NotFoundException for a client attendee belonging to a different org (DENY)", async () => {
    const db = makeDb();
    const svc = new CrmMeetingBriefService(db, mockGateway, makeOrgFeatures());
    await expect(
      svc.meetingPrep(ATTACKER_ORG, {
        meetingTitle: "Q4 Review",
        attendeeType: "client",
        attendeeId: 42,
        scheduledAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it("meetingFollowUpDraft throws NotFoundException when lead belongs to a different org — cross-org isolation", async () => {
    const db = makeDb();
    const svc = new CrmMeetingBriefService(db, mockGateway, makeOrgFeatures());
    await expect(
      svc.meetingFollowUpDraft(ATTACKER_ORG, {
        meetingTitle: "Follow-up",
        attendeeType: "lead",
        attendeeId: 7,
        outcome: "interested",
        scheduledAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(NotFoundException);
  });
});
