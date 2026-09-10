import { CronSignService } from "./cron-sign.service";
import type { Db } from "../../db/drizzle.module";
import type { SignEnvelopesService } from "../e-sign/sign-envelopes.service";
import * as tenant from "../../common/tenant";

jest.mock("../../common/tenant", () => ({
  ...jest.requireActual("../../common/tenant"),
  forEachOrg: jest.fn(),
}));

const forEachOrg = tenant.forEachOrg as jest.MockedFunction<typeof tenant.forEachOrg>;

const ORG_A = "org-a";
const ORG_B = "org-b";

/**
 * Drives the callback `forEachOrg` would drive, for the organisations given.
 * The real one opens a transaction per org and swallows a failing org's error;
 * this only has to prove which orgIds the sweep is handed.
 */
function walkOrgs(orgIds: string[]) {
  forEachOrg.mockImplementation(async (_db, _sweep, fn) => {
    for (const orgId of orgIds) await fn({} as never, orgId);
    return { organizations: orgIds.length, succeeded: orgIds.length, failed: 0 };
  });
}

function makeEnvelopes() {
  const calls: string[] = [];
  const service = {
    runExpirationSweep: jest.fn(async (orgId: string) => {
      calls.push(`expire:${orgId}`);
      return 2;
    }),
    runReminderSweep: jest.fn(async (orgId: string) => {
      calls.push(`remind:${orgId}`);
      return 3;
    }),
  };
  return { service, calls };
}

describe("CronSignService", () => {
  beforeEach(() => forEachOrg.mockReset());

  it("sweeps each organisation with its own id, never a shared pass", async () => {
    /*
     * The whole reason this service exists rather than one call over the table.
     * If this ever calls the sweeps without an orgId, the per-tenant scoping is
     * gone again — and the sweeps re-issue signing tokens and expire envelopes,
     * so "gone" means other tenants' signers get email.
     *
     * The older note here said no `sign_*` table is under RLS. It is out of date:
     * they all carry `tenant_isolation` now. That makes RLS a backstop, not a
     * reason to stop passing the id — this assertion is about the id reaching
     * the sweep, which is what keeps the call correct on its own terms.
     */
    walkOrgs([ORG_A, ORG_B]);
    const { service, calls } = makeEnvelopes();

    const report = await new CronSignService({} as Db, service as unknown as SignEnvelopesService).sweepEnvelopes();

    expect(calls).toEqual([
      `expire:${ORG_A}`,
      `remind:${ORG_A}`,
      `expire:${ORG_B}`,
      `remind:${ORG_B}`,
    ]);
    expect(report).toEqual({ organizations: 2, failed: 0, reminded: 6, expired: 4 });
  });

  it("expires before it reminds", async () => {
    /*
     * Order is a correctness property, not a preference. A reminder re-issues a
     * signing token and emails the link; reminding first would send a fresh
     * link for an envelope this same tick is about to close.
     */
    walkOrgs([ORG_A]);
    const { service, calls } = makeEnvelopes();

    await new CronSignService({} as Db, service as unknown as SignEnvelopesService).sweepEnvelopes();

    expect(calls.indexOf(`expire:${ORG_A}`)).toBeLessThan(calls.indexOf(`remind:${ORG_A}`));
  });

  it("reports the organisations that failed rather than reporting success", async () => {
    forEachOrg.mockResolvedValue({ organizations: 3, succeeded: 2, failed: 1 });
    const { service } = makeEnvelopes();

    const report = await new CronSignService({} as Db, service as unknown as SignEnvelopesService).sweepEnvelopes();

    expect(report.failed).toBe(1);
    expect(report.organizations).toBe(2);
  });
});
