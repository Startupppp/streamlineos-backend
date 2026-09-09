const resolveTxt = jest.fn();
jest.mock("node:dns/promises", () => ({ resolveTxt: (name: string) => resolveTxt(name) }));

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.types";
import { crmColdOutboundSettings, crmSendingDomains } from "../../db/schema";
import { ColdOutboundAdminService } from "./cold-outbound-admin.service";

/**
 * Turning cold outreach on, which nothing could do.
 *
 * `evaluateColdGate` reads two tables and refuses when either is unset, and the
 * only writer either had was the send path's own pause. The tests that matter
 * here are the refusals: a domain verifies because DNS says so and not because
 * the caller asked, and the track enables only behind a domain that is both
 * verified and warming. Each of those is the difference between a ramp and a
 * tenant sending cold mail from a domain they do not own.
 */

const ORG = "org-1";
const DOMAIN_ID = "11111111-2222-3333-4444-555555555555";

function query<T>(rows: T[]) {
  return {
    then: (resolve: (value: T[]) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
    limit: async () => rows,
  };
}

type DomainRow = {
  domain: string;
  verifiedAt: Date | null;
  warmupStartedAt: Date | null;
};

function makeService(options: {
  domains?: DomainRow[];
  settings?: { pausedAt: Date | null } | null;
  updated?: jest.Mock;
  inserted?: jest.Mock;
  updatedRows?: unknown[];
}) {
  const updated = options.updated ?? jest.fn();
  const inserted = options.inserted ?? jest.fn();

  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === crmSendingDomains) return { where: () => query(options.domains ?? []) };
        if (table === crmColdOutboundSettings)
          return { where: () => query(options.settings ? [options.settings] : []) };
        throw new Error("unexpected read");
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updated({ table, values });
          return {
            returning: async () => options.updatedRows ?? [{ organizationId: ORG }],
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
          };
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          inserted(values);
          return [{ sendingDomainId: DOMAIN_ID }];
        },
        onConflictDoUpdate: async (conflict: { set: Record<string, unknown> }) => {
          inserted({ ...values, ...conflict.set });
        },
      }),
    }),
  } as unknown as Db;

  return { svc: new ColdOutboundAdminService(db), updated, inserted };
}

beforeEach(() => resolveTxt.mockReset());

describe("verifying a sending domain", () => {
  const unverified: DomainRow = { domain: "acme-outreach.com", verifiedAt: null, warmupStartedAt: null };

  it("asks DNS for the record under this organisation's own name", async () => {
    resolveTxt.mockResolvedValue([[`streamline-verify=${DOMAIN_ID}`]]);
    const { svc } = makeService({ domains: [unverified] });

    await svc.verifyDomain(ORG, DOMAIN_ID);

    expect(resolveTxt).toHaveBeenCalledWith("_streamline-verify.acme-outreach.com");
  });

  it("marks the domain verified once the record carries its id", async () => {
    resolveTxt.mockResolvedValue([[`streamline-verify=${DOMAIN_ID}`]]);
    const { svc, updated } = makeService({ domains: [unverified] });

    const result = await svc.verifyDomain(ORG, DOMAIN_ID);

    expect(result.verified).toBe(true);
    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({
        table: crmSendingDomains,
        values: expect.objectContaining({ verifiedAt: expect.any(Date) }),
      }),
    );
  });

  /**
   * The whole point. A record that exists but names a different domain's id is
   * somebody else's proof, and accepting it would let one tenant verify a domain
   * another tenant had already published a token for.
   */
  it("refuses a record that carries somebody else's id, and writes nothing", async () => {
    resolveTxt.mockResolvedValue([["streamline-verify=99999999-0000-0000-0000-000000000000"]]);
    const { svc, updated } = makeService({ domains: [unverified] });

    await expect(svc.verifyDomain(ORG, DOMAIN_ID)).rejects.toBeInstanceOf(BadRequestException);
    expect(updated).not.toHaveBeenCalled();
  });

  it("refuses when the name resolves but holds only unrelated records", async () => {
    resolveTxt.mockResolvedValue([["v=spf1 include:example.com ~all"], ["google-site-verification=x"]]);
    const { svc, updated } = makeService({ domains: [unverified] });

    await expect(svc.verifyDomain(ORG, DOMAIN_ID)).rejects.toBeInstanceOf(BadRequestException);
    expect(updated).not.toHaveBeenCalled();
  });

  /** A long TXT value arrives split at 255 characters and means nothing until joined. */
  it("joins the chunks of a split record before comparing", async () => {
    const value = `streamline-verify=${DOMAIN_ID}`;
    resolveTxt.mockResolvedValue([[value.slice(0, 10), value.slice(10)]]);
    const { svc, updated } = makeService({ domains: [unverified] });

    await expect(svc.verifyDomain(ORG, DOMAIN_ID)).resolves.toMatchObject({ verified: true });
    expect(updated).toHaveBeenCalled();
  });

  it("reports an unreadable name as not-yet-published rather than failing the request", async () => {
    resolveTxt.mockRejectedValue(Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" }));
    const { svc } = makeService({ domains: [unverified] });

    await expect(svc.verifyDomain(ORG, DOMAIN_ID)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("does not re-read DNS for a domain already verified", async () => {
    const verifiedAt = new Date("2026-01-01T00:00:00Z");
    const { svc, updated } = makeService({
      domains: [{ ...unverified, verifiedAt }],
    });

    await expect(svc.verifyDomain(ORG, DOMAIN_ID)).resolves.toEqual({ verified: true, verifiedAt });
    expect(resolveTxt).not.toHaveBeenCalled();
    expect(updated).not.toHaveBeenCalled();
  });

  it("404s a domain belonging to nobody in this organisation", async () => {
    const { svc } = makeService({ domains: [] });
    await expect(svc.verifyDomain(ORG, DOMAIN_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("starting warm-up", () => {
  it("refuses an unverified domain", async () => {
    const { svc, updated } = makeService({
      domains: [{ domain: "acme-outreach.com", verifiedAt: null, warmupStartedAt: null }],
    });

    await expect(svc.startWarmup(ORG, DOMAIN_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(updated).not.toHaveBeenCalled();
  });

  /** Restarting the clock would rewind the ramp to day one and its smallest cap. */
  it("leaves an already-started warm-up where it is", async () => {
    const warmupStartedAt = new Date("2026-01-01T00:00:00Z");
    const { svc, updated } = makeService({
      domains: [{ domain: "acme-outreach.com", verifiedAt: new Date(), warmupStartedAt }],
    });

    await expect(svc.startWarmup(ORG, DOMAIN_ID)).resolves.toEqual({ warmupStartedAt });
    expect(updated).not.toHaveBeenCalled();
  });

  it("starts the clock on a verified domain", async () => {
    const { svc, updated } = makeService({
      domains: [{ domain: "acme-outreach.com", verifiedAt: new Date(), warmupStartedAt: null }],
    });

    await svc.startWarmup(ORG, DOMAIN_ID);

    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({ values: expect.objectContaining({ warmupStartedAt: expect.any(Date) }) }),
    );
  });
});

describe("enabling the track", () => {
  /**
   * Each of these is a state `evaluateColdGate` would refuse anyway. Refusing
   * here too is the difference between a tenant reading why, and a tenant with
   * an enabled track whose every send is silently dropped.
   */
  it("refuses with no cold domain registered", async () => {
    const { svc, inserted } = makeService({ domains: [] });
    await expect(svc.enable(ORG, "user-1")).rejects.toBeInstanceOf(ConflictException);
    expect(inserted).not.toHaveBeenCalled();
  });

  it("refuses behind an unverified cold domain", async () => {
    const { svc, inserted } = makeService({
      domains: [{ domain: "acme-outreach.com", verifiedAt: null, warmupStartedAt: null }],
    });
    await expect(svc.enable(ORG, "user-1")).rejects.toBeInstanceOf(ConflictException);
    expect(inserted).not.toHaveBeenCalled();
  });

  it("refuses behind a verified domain whose warm-up never started", async () => {
    const { svc, inserted } = makeService({
      domains: [{ domain: "acme-outreach.com", verifiedAt: new Date(), warmupStartedAt: null }],
    });
    await expect(svc.enable(ORG, "user-1")).rejects.toBeInstanceOf(ConflictException);
    expect(inserted).not.toHaveBeenCalled();
  });

  it("enables behind a verified, warming domain and records who did it", async () => {
    const { svc, inserted } = makeService({
      domains: [{ domain: "acme-outreach.com", verifiedAt: new Date(), warmupStartedAt: new Date() }],
    });

    await expect(svc.enable(ORG, "user-1")).resolves.toMatchObject({ enabled: true });
    expect(inserted).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, enabledByUserId: "user-1" }),
    );
  });
});

describe("pausing and resuming", () => {
  /**
   * A pause is the send path's own halt on bounces or complaints. Enabling must
   * not clear it, or "turn it back on" quietly resumes into whatever caused it.
   */
  it("leaves a pause in place when the track is disabled", async () => {
    const { svc, inserted } = makeService({});
    await svc.disable(ORG, "user-1");

    const values = inserted.mock.calls[0]![0] as Record<string, unknown>;
    expect(values.enabled).toBe(false);
    expect(values).not.toHaveProperty("pausedAt");
  });

  it("clears the pause and its reason only when resumed explicitly", async () => {
    const { svc, updated } = makeService({ settings: { pausedAt: new Date() } });

    await expect(svc.resume(ORG, "user-1")).resolves.toEqual({ resumed: true });
    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({
        table: crmColdOutboundSettings,
        values: expect.objectContaining({ pausedAt: null, pauseReason: null }),
      }),
    );
  });

  it("404s a resume for an organisation that has no cold track row", async () => {
    const { svc } = makeService({ updatedRows: [] });
    await expect(svc.resume(ORG, "user-1")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("the overview", () => {
  it("treats a tenant with no row as not enabled", async () => {
    const { svc } = makeService({ settings: null, domains: [] });
    await expect(svc.overview(ORG)).resolves.toMatchObject({ enabled: false, pausedAt: null });
  });

  it("tells an unverified domain exactly what to publish, and stops once verified", async () => {
    const { svc } = makeService({
      domains: [
        { sendingDomainId: DOMAIN_ID, domain: "acme-outreach.com", verifiedAt: null } as never,
        { sendingDomainId: "other", domain: "acme.com", verifiedAt: new Date() } as never,
      ],
    });

    const result = await svc.overview(ORG);

    expect(result.domains[0]!.verificationRecord).toEqual({
      name: "_streamline-verify.acme-outreach.com",
      value: `streamline-verify=${DOMAIN_ID}`,
    });
    expect(result.domains[1]!.verificationRecord).toBeNull();
  });
});
