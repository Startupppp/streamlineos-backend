import { CronHelpdeskRetentionService } from "../cron-helpdesk-retention.service";
import { CronMailRetentionService } from "../cron-mail-retention.service";
import { CronAnnouncementsRetentionService } from "../cron-announcements-retention.service";
import type { Db } from "../../../db/drizzle.module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

jest.mock("../../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

import { forEachOrg } from "../../../common/tenant";

type OrgCallback = (tx: unknown, orgId: string) => Promise<void>;

const OWNER_ORG = "org-a";
const OTHER_ORG = "org-b";

function srcFile(name: string): string {
  return readFileSync(resolve(__dirname, "..", name), "utf8");
}

function makeDeleteTx(deletedCount = 2) {
  const returning = jest.fn().mockResolvedValue(
    Array.from({ length: deletedCount }, (_, i) => ({ id: i + 1 })),
  );
  const where = jest.fn().mockReturnValue({ returning });
  const values = jest.fn().mockResolvedValue(undefined);
  const insert = jest.fn().mockReturnValue({ values });
  return {
    delete: jest.fn().mockReturnValue({ where }),
    insert,
    returning,
    where,
  };
}

describe("CronHelpdeskRetentionService", () => {
  beforeEach(() => jest.resetAllMocks());

  it("returns aggregate counts across all orgs", async () => {
    const tx = makeDeleteTx(3);
    (forEachOrg as jest.Mock).mockImplementation(
      async (_db: unknown, _label: string, cb: OrgCallback) => {
        await cb(tx, OWNER_ORG);
        await cb(tx, OTHER_ORG);
        return { organizations: 2, succeeded: 2, failed: 0 };
      },
    );
    const db = {} as unknown as Db;
    const svc = new CronHelpdeskRetentionService(db);

    const result = await svc.sweep();

    expect(result.organizations).toBe(2);
    expect(result.ticketsDeleted).toBe(6);
  });

  it("iterates with forEachOrg — each org gets its own bounded sweep", async () => {
    const tx = makeDeleteTx(1);
    (forEachOrg as jest.Mock).mockImplementation(
      async (_db: unknown, _label: string, cb: OrgCallback) => {
        await cb(tx, OWNER_ORG);
        await cb(tx, OTHER_ORG);
        return { organizations: 2, succeeded: 2, failed: 0 };
      },
    );
    const db = {} as unknown as Db;
    const svc = new CronHelpdeskRetentionService(db);

    const result = await svc.sweep();

    expect(result.ticketsDeleted).toBe(2);
    expect((forEachOrg as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it("issues a DELETE bounded by a LIMIT clause — never unbounded", () => {
    const content = srcFile("cron-helpdesk-retention.service.ts");
    expect(content).toMatch(/LIMIT/);
  });

  it("excludes subjects under active legal holds from deletion — atomic subquery", () => {
    const content = srcFile("cron-helpdesk-retention.service.ts");
    expect(content).toMatch(/hr_legal_holds/);
    expect(content).toMatch(/status = 'active'/);
  });

  it("writes an audit log entry when tickets are deleted — non-zero count triggers insert", async () => {
    const tx = makeDeleteTx(2);
    (forEachOrg as jest.Mock).mockImplementation(
      async (_db: unknown, _label: string, cb: OrgCallback) => {
        await cb(tx, OWNER_ORG);
        return { organizations: 1, succeeded: 1, failed: 0 };
      },
    );
    const db = {} as unknown as Db;
    const svc = new CronHelpdeskRetentionService(db);

    await svc.sweep();

    expect(tx.insert).toHaveBeenCalled();
  });

  it("does not write an audit log when no tickets match the cutoff", async () => {
    const returning = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ returning });
    const insert = jest.fn();
    const tx = { delete: jest.fn().mockReturnValue({ where }), insert };
    (forEachOrg as jest.Mock).mockImplementation(
      async (_db: unknown, _label: string, cb: OrgCallback) => {
        await cb(tx, OWNER_ORG);
        return { organizations: 1, succeeded: 1, failed: 0 };
      },
    );
    const db = {} as unknown as Db;
    const svc = new CronHelpdeskRetentionService(db);

    const result = await svc.sweep();

    expect(result.ticketsDeleted).toBe(0);
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

describe("CronMailRetentionService", () => {
  beforeEach(() => jest.resetAllMocks());

  it("returns aggregate counts across all orgs", async () => {
    const tx = makeDeleteTx(5);
    (forEachOrg as jest.Mock).mockImplementation(
      async (_db: unknown, _label: string, cb: OrgCallback) => {
        await cb(tx, OWNER_ORG);
        return { organizations: 1, succeeded: 1, failed: 0 };
      },
    );
    const db = {} as unknown as Db;
    const svc = new CronMailRetentionService(db);

    const result = await svc.sweep();

    expect(result.organizations).toBe(1);
    expect(result.rowsDeleted).toBe(5);
  });

  it("issues a DELETE bounded by a LIMIT clause — never unbounded", () => {
    const content = srcFile("cron-mail-retention.service.ts");
    expect(content).toMatch(/LIMIT/);
  });

  it("scopes deletion to org_id — cross-tenant isolation proof", () => {
    const content = srcFile("cron-mail-retention.service.ts");
    expect(content).toMatch(/org_id\s*=\s*\$\{orgId\}/);
  });

  it("accumulates rowsDeleted across multiple orgs", async () => {
    const tx = makeDeleteTx(4);
    (forEachOrg as jest.Mock).mockImplementation(
      async (_db: unknown, _label: string, cb: OrgCallback) => {
        await cb(tx, OWNER_ORG);
        await cb(tx, OTHER_ORG);
        return { organizations: 2, succeeded: 2, failed: 0 };
      },
    );
    const db = {} as unknown as Db;
    const svc = new CronMailRetentionService(db);

    const result = await svc.sweep();

    expect(result.organizations).toBe(2);
    expect(result.rowsDeleted).toBe(8);
  });
});

describe("CronAnnouncementsRetentionService", () => {
  beforeEach(() => jest.resetAllMocks());

  it("reports aggregate expired and aged counts from two sweep phases", async () => {
    const returning = jest.fn()
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
      .mockResolvedValueOnce([{ id: 3 }]);
    const where = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockResolvedValue(undefined);
    const insert = jest.fn().mockReturnValue({ values });
    const tx = { delete: jest.fn().mockReturnValue({ where }), insert };

    (forEachOrg as jest.Mock).mockImplementation(
      async (_db: unknown, _label: string, cb: OrgCallback) => {
        await cb(tx, OWNER_ORG);
        return { organizations: 1, succeeded: 1, failed: 0 };
      },
    );
    const db = {} as unknown as Db;
    const svc = new CronAnnouncementsRetentionService(db);

    const result = await svc.sweep();

    expect(result.expiredDeleted).toBe(2);
    expect(result.agedDeleted).toBe(1);
  });

  it("issues DELETE with LIMIT for both sweep phases — never unbounded", () => {
    const content = srcFile("cron-announcements-retention.service.ts");
    const limitMatches = content.match(/LIMIT/g);
    expect(limitMatches).not.toBeNull();
    expect(limitMatches!.length).toBeGreaterThanOrEqual(2);
  });

  it("scopes both sweeps to org_id — cross-tenant isolation proof", () => {
    const content = srcFile("cron-announcements-retention.service.ts");
    const orgMatches = content.match(/org_id\s*=\s*\$\{orgId\}/g);
    expect(orgMatches).not.toBeNull();
    expect(orgMatches!.length).toBeGreaterThanOrEqual(2);
  });

  it("writes an audit log when any records are deleted", async () => {
    const returning = jest.fn()
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([]);
    const where = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockResolvedValue(undefined);
    const insert = jest.fn().mockReturnValue({ values });
    const tx = { delete: jest.fn().mockReturnValue({ where }), insert };

    (forEachOrg as jest.Mock).mockImplementation(
      async (_db: unknown, _label: string, cb: OrgCallback) => {
        await cb(tx, OWNER_ORG);
        return { organizations: 1, succeeded: 1, failed: 0 };
      },
    );
    const db = {} as unknown as Db;
    const svc = new CronAnnouncementsRetentionService(db);

    await svc.sweep();

    expect(tx.insert).toHaveBeenCalled();
  });

  it("skips the audit log when both phases delete zero rows", async () => {
    const returning = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ returning });
    const insert = jest.fn();
    const tx = { delete: jest.fn().mockReturnValue({ where }), insert };

    (forEachOrg as jest.Mock).mockImplementation(
      async (_db: unknown, _label: string, cb: OrgCallback) => {
        await cb(tx, OWNER_ORG);
        return { organizations: 1, succeeded: 1, failed: 0 };
      },
    );
    const db = {} as unknown as Db;
    const svc = new CronAnnouncementsRetentionService(db);

    const result = await svc.sweep();

    expect(result.expiredDeleted).toBe(0);
    expect(result.agedDeleted).toBe(0);
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

describe("per-tenant failure visibility", () => {
  beforeEach(() => jest.resetAllMocks());

  it.each([
    ["helpdesk", () => new CronHelpdeskRetentionService({} as unknown as Db)],
    ["mail", () => new CronMailRetentionService({} as unknown as Db)],
    ["announcements", () => new CronAnnouncementsRetentionService({} as unknown as Db)],
  ])(
    "%s: a tenant whose sweep threw is reported, not swallowed into a clean success",
    async (_name, build) => {
      const tx = makeDeleteTx(1);
      (forEachOrg as jest.Mock).mockImplementation(
        async (_db: unknown, _label: string, cb: OrgCallback) => {
          await cb(tx, OWNER_ORG);
          return { organizations: 2, succeeded: 1, failed: 1 };
        },
      );

      const result = await build().sweep();

      expect(result.organizations).toBe(2);
      expect(result.organizationsFailed).toBe(1);
    },
  );
});
