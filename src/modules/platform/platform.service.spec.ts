import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { APP_CONFIG } from "../../config/config.module";
import { EmailService } from "../email/email.service";
import { PlatformService } from "./platform.service";

type Terminal = "limit" | "groupBy" | "orderBy";

function makeChain(resolveWith: unknown[], terminal: Terminal = "limit") {
  const chain: Record<string, jest.Mock> = {};
  const resolve = () => Promise.resolve(resolveWith);

  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);

  if (terminal === "limit") {
    chain.orderBy = jest.fn().mockReturnValue(chain);
    chain.groupBy = jest.fn().mockReturnValue(chain);
    chain.limit = jest.fn().mockImplementation(resolve);
  } else if (terminal === "groupBy") {
    chain.orderBy = jest.fn().mockReturnValue(chain);
    chain.limit = jest.fn().mockReturnValue(chain);
    chain.groupBy = jest.fn().mockImplementation(resolve);
  } else {
    chain.groupBy = jest.fn().mockReturnValue(chain);
    chain.limit = jest.fn().mockReturnValue(chain);
    chain.orderBy = jest.fn().mockImplementation(resolve);
  }

  return chain;
}

const STUB_ORG = {
  id: "org-001",
  slug: "acme",
  name: "Acme Corp",
  createdAt: new Date("2024-01-01"),
};

function makeListCustomersDb(opts: {
  orgs?: typeof STUB_ORG[];
  memberCounts?: { orgId: string; count: number }[];
  paymentTotals?: { orgId: string; total: number }[];
  subRows?: { orgId: string; plan: string; status: string; subId: number }[];
  extraOrgs?: number;
}) {
  const orgs = opts.orgs ?? [STUB_ORG];
  const extra = opts.extraOrgs ?? 0;
  const extraOrgs = Array.from({ length: extra }, (_, i) => ({
    id: `org-extra-${i}`,
    slug: `extra-${i}`,
    name: `Extra ${i}`,
    createdAt: new Date("2024-01-02"),
  }));

  const orgPage = [...orgs, ...extraOrgs];
  const memberCounts = opts.memberCounts ?? [{ orgId: "org-001", count: 3 }];
  const paymentTotals = opts.paymentTotals ?? [];
  const subRows = opts.subRows ?? [];

  const orgsChain = makeChain(orgPage, "limit");
  const membersChain = makeChain(memberCounts, "groupBy");
  const paymentsChain = makeChain(paymentTotals, "groupBy");
  const subsChain = makeChain(subRows, "orderBy");

  return {
    select: jest.fn()
      .mockReturnValueOnce(orgsChain)
      .mockReturnValueOnce(membersChain)
      .mockReturnValueOnce(paymentsChain)
      .mockReturnValueOnce(subsChain),
  };
}

function makeGetCustomerDb(opts: {
  org?: Record<string, unknown> | null;
  members?: unknown[];
  payments?: unknown[];
  subRow?: { id: number; plan: string; status: string } | null;
}) {
  const org = opts.org !== undefined ? opts.org : { ...STUB_ORG, ownerId: null };
  const members = opts.members ?? [];
  const payments = opts.payments ?? [];
  const subRow = opts.subRow !== undefined ? opts.subRow : null;
  const subRows = subRow ? [subRow] : [];

  const membersChain = makeChain(members, "limit");
  const subsChain = makeChain(subRows, "limit");

  return {
    query: {
      organizations: {
        findFirst: jest.fn().mockResolvedValue(org),
      },
      platformPayments: {
        findMany: jest.fn().mockResolvedValue(payments),
      },
    },
    select: jest.fn()
      .mockReturnValueOnce(membersChain)
      .mockReturnValueOnce(subsChain),
  };
}

async function buildService(db: unknown): Promise<PlatformService> {
  const module = await Test.createTestingModule({
    providers: [
      PlatformService,
      { provide: DRIZZLE, useValue: db },
      { provide: APP_CONFIG, useValue: { APP_URL: "https://example.com", CONTACT_NOTIFICATION_EMAIL: null } },
      { provide: EmailService, useValue: { sendEmail: jest.fn() } },
    ],
  }).compile();
  return module.get(PlatformService);
}

describe("PlatformService.listCustomers — subscription state contract", () => {
  it("paid subscription (ACTIVE) — returns correct plan and status", async () => {
    const db = makeListCustomersDb({
      subRows: [{ orgId: "org-001", plan: "STARTER", status: "ACTIVE", subId: 1 }],
    });
    const svc = await buildService(db);
    const result = await svc.listCustomers();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: "org-001", plan: "STARTER", status: "ACTIVE" });
  });

  it("trial subscription — returns TRIAL status", async () => {
    const db = makeListCustomersDb({
      subRows: [{ orgId: "org-001", plan: "STARTER", status: "TRIAL", subId: 2 }],
    });
    const svc = await buildService(db);
    const result = await svc.listCustomers();
    expect(result.items[0]).toMatchObject({ plan: "STARTER", status: "TRIAL" });
  });

  it("cancelled subscription — returns CANCELLED status", async () => {
    const db = makeListCustomersDb({
      subRows: [{ orgId: "org-001", plan: "STARTER", status: "CANCELLED", subId: 3 }],
    });
    const svc = await buildService(db);
    const result = await svc.listCustomers();
    expect(result.items[0]).toMatchObject({ plan: "STARTER", status: "CANCELLED" });
  });

  it("missing subscription — plan is null and status defaults to free", async () => {
    const db = makeListCustomersDb({ subRows: [] });
    const svc = await buildService(db);
    const result = await svc.listCustomers();
    expect(result.items[0]).toMatchObject({ plan: null, status: "free" });
  });

  it("concurrent webhook state — highest sub id (desc order first) is the authoritative row", async () => {
    const db = makeListCustomersDb({
      subRows: [
        { orgId: "org-001", plan: "PROFESSIONAL", status: "ACTIVE", subId: 99 },
        { orgId: "org-001", plan: "STARTER", status: "TRIAL", subId: 1 },
      ],
    });
    const svc = await buildService(db);
    const result = await svc.listCustomers();
    expect(result.items[0]).toMatchObject({ plan: "PROFESSIONAL", status: "ACTIVE" });
  });

  it("member count is taken from member aggregate, not org row", async () => {
    const db = makeListCustomersDb({
      memberCounts: [{ orgId: "org-001", count: 7 }],
    });
    const svc = await buildService(db);
    const result = await svc.listCustomers();
    expect(result.items[0]).toMatchObject({ userCount: 7 });
  });

  it("org with no member count rows defaults to zero", async () => {
    const db = makeListCustomersDb({ memberCounts: [] });
    const svc = await buildService(db);
    const result = await svc.listCustomers();
    expect(result.items[0]).toMatchObject({ userCount: 0 });
  });

  it("org with captured payments — lifetimeInr is set from payment aggregate", async () => {
    const db = makeListCustomersDb({
      paymentTotals: [{ orgId: "org-001", total: 49900 }],
    });
    const svc = await buildService(db);
    const result = await svc.listCustomers();
    expect(result.items[0]).toMatchObject({ lifetimeInr: 49900 });
  });

  it("reads across all orgs without tenant scope — returns multiple orgs", async () => {
    const orgs = [
      { id: "org-a", slug: "alpha", name: "Alpha", createdAt: new Date("2024-02-01") },
      { id: "org-b", slug: "beta", name: "Beta", createdAt: new Date("2024-01-01") },
    ];
    const db = makeListCustomersDb({
      orgs,
      memberCounts: [],
      paymentTotals: [],
      subRows: [
        { orgId: "org-a", plan: "PROFESSIONAL", status: "ACTIVE", subId: 10 },
      ],
    });
    const svc = await buildService(db);
    const result = await svc.listCustomers();
    expect(result.items).toHaveLength(2);
    const alpha = result.items.find((i) => i.id === "org-a");
    const beta = result.items.find((i) => i.id === "org-b");
    expect(alpha).toMatchObject({ plan: "PROFESSIONAL", status: "ACTIVE" });
    expect(beta).toMatchObject({ plan: null, status: "free" });
  });
});

describe("PlatformService.listCustomers — cursor contract", () => {
  it("empty result — nextCursor is null", async () => {
    const emptyChain = makeChain([], "limit");
    const db = { select: jest.fn().mockReturnValue(emptyChain) };
    const svc = await buildService(db);
    const result = await svc.listCustomers();
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("fewer than 100 orgs — nextCursor is null", async () => {
    const db = makeListCustomersDb({});
    const svc = await buildService(db);
    const result = await svc.listCustomers();
    expect(result.nextCursor).toBeNull();
  });

  it("101 orgs returned by DB — page is capped at 100 and nextCursor is set", async () => {
    const allOrgs = Array.from({ length: 101 }, (_, i) => ({
      id: `org-${i}`,
      slug: `slug-${i}`,
      name: `Org ${i}`,
      createdAt: new Date("2024-01-01"),
    }));

    const orgsChain = makeChain(allOrgs, "limit");
    const membersChain = makeChain([], "groupBy");
    const paymentsChain = makeChain([], "groupBy");
    const subsChain = makeChain([], "orderBy");

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(orgsChain)
        .mockReturnValueOnce(membersChain)
        .mockReturnValueOnce(paymentsChain)
        .mockReturnValueOnce(subsChain),
    };
    const svc = await buildService(db);
    const result = await svc.listCustomers();
    expect(result.items).toHaveLength(100);
    expect(result.nextCursor).not.toBeNull();
    expect(result.nextCursor).toMatchObject({
      afterCreatedAt: expect.any(Date),
      afterId: expect.any(String),
    });
  });

  it("cursor afterId is taken from the 100th item, not the 101st", async () => {
    const allOrgs = Array.from({ length: 101 }, (_, i) => ({
      id: `org-${String(i).padStart(3, "0")}`,
      slug: `slug-${i}`,
      name: `Org ${i}`,
      createdAt: new Date("2024-01-01"),
    }));

    const orgsChain = makeChain(allOrgs, "limit");
    const membersChain = makeChain([], "groupBy");
    const paymentsChain = makeChain([], "groupBy");
    const subsChain = makeChain([], "orderBy");

    const db = {
      select: jest.fn()
        .mockReturnValueOnce(orgsChain)
        .mockReturnValueOnce(membersChain)
        .mockReturnValueOnce(paymentsChain)
        .mockReturnValueOnce(subsChain),
    };
    const svc = await buildService(db);
    const result = await svc.listCustomers();
    expect(result.nextCursor?.afterId).toBe(allOrgs[99]!.id);
    expect(result.nextCursor?.afterId).not.toBe(allOrgs[100]!.id);
  });
});

describe("PlatformService.getCustomerBySlug — subscription state contract", () => {
  it("org found with paid subscription — returns subscription details", async () => {
    const sub = {
      id: 5,
      plan: "PROFESSIONAL",
      status: "ACTIVE",
      razorpaySubscriptionId: "sub_abc",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      trialEndsAt: null,
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = makeGetCustomerDb({ subRow: sub });
    const svc = await buildService(db);
    const result = await svc.getCustomerBySlug("acme");
    expect(result.subscription).toMatchObject({ plan: "PROFESSIONAL", status: "ACTIVE" });
  });

  it("org found with no subscription — subscription is null", async () => {
    const db = makeGetCustomerDb({ subRow: null });
    const svc = await buildService(db);
    const result = await svc.getCustomerBySlug("acme");
    expect(result.subscription).toBeNull();
  });

  it("org not found — throws NotFoundException", async () => {
    const db = makeGetCustomerDb({ org: null });
    const svc = await buildService(db);
    await expect(svc.getCustomerBySlug("no-such-slug")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("trial subscription — trialEndsAt forwarded from canonical subscriptions table", async () => {
    const trialEndsAt = new Date("2024-06-30");
    const sub = {
      id: 2,
      plan: "STARTER",
      status: "TRIAL",
      razorpaySubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      trialEndsAt,
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = makeGetCustomerDb({ subRow: sub });
    const svc = await buildService(db);
    const result = await svc.getCustomerBySlug("acme");
    expect(result.subscription?.trialEndsAt).toEqual(trialEndsAt);
  });

  it("cancelled subscription — cancelledAt forwarded from canonical subscriptions table", async () => {
    const cancelledAt = new Date("2024-03-15");
    const sub = {
      id: 3,
      plan: "STARTER",
      status: "CANCELLED",
      razorpaySubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      trialEndsAt: null,
      cancelledAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = makeGetCustomerDb({ subRow: sub });
    const svc = await buildService(db);
    const result = await svc.getCustomerBySlug("acme");
    expect(result.subscription?.cancelledAt).toEqual(cancelledAt);
  });
});
