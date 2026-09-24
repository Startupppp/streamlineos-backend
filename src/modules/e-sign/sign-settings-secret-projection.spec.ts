import { getTableColumns } from "drizzle-orm";
import { SignSettingsService } from "./sign-settings.service";
import { signOrgSettings } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import type { SignAuditService } from "./sign-audit.service";

/**
 * PRD-C088 — `GET /sign/admin/settings` must not carry `webhookSecret`.
 *
 * `sign_org_settings.webhook_secret` is a plaintext shared secret
 * (`db/schema/e-sign/settings.ts:45`). `getOrCreate` was a bare `findFirst` with no
 * `columns` and `update` a bare `.returning()`, and `SignAdminController.getSettings`
 * returns whichever one ran verbatim — so the secret was on the wire of every settings
 * read, to every holder of `sign:admin:manage`, with no consumer that ever wanted it.
 *
 * The assertions are on the arguments the service hands drizzle, not on the mocked row:
 * a mock cannot project, so a bare `findFirst`/`.returning()` would return the stubbed
 * row either way and prove nothing. Reverting either call site fails here.
 */

const ORG = "org-sign-settings-spec";

/** A row shaped like the table, including the secret a bare read would return. */
function fullRow(): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const column of Object.keys(getTableColumns(signOrgSettings))) row[column] = null;
  return { ...row, id: 1, orgId: ORG, brandingJson: {}, webhookSecret: "whsec_live_abcdef123456" };
}

function auditStub(): SignAuditService {
  const stub: Pick<SignAuditService, "record"> = { record: jest.fn().mockResolvedValue(undefined) };
  return stub as SignAuditService;
}

describe("SignSettingsService.getOrCreate — the webhook secret is never selected", () => {
  beforeEach(() => jest.resetAllMocks());

  it("excludes webhookSecret from the findFirst column set", async () => {
    const findFirst = jest.fn().mockResolvedValue(fullRow());
    const db = { query: { signOrgSettings: { findFirst } } } as unknown as Db;

    await new SignSettingsService(db, auditStub()).getOrCreate(ORG);

    expect(findFirst).toHaveBeenCalledTimes(1);
    const [args] = findFirst.mock.calls[0] ?? [];
    const columns = (args as { columns?: Record<string, boolean> } | undefined)?.columns;
    // A bare read passes no `columns` at all — that IS the defect.
    expect(columns).toBeDefined();
    expect(columns?.webhookSecret).toBe(false);
  });

  it("excludes webhookSecret from the insert projection on first write", async () => {
    let returningArg: unknown;
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { signOrgSettings: { findFirst } },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockReturnValue({
            returning: jest.fn().mockImplementation((arg: unknown) => {
              returningArg = arg;
              return Promise.resolve([fullRow()]);
            }),
          }),
        }),
      }),
    } as unknown as Db;

    await new SignSettingsService(db, auditStub()).getOrCreate(ORG);

    expect(returningArg).toBeDefined();
    const projected = Object.keys(returningArg as Record<string, unknown>);
    expect(projected).not.toContain("webhookSecret");
    // Anti-vacuity: the projection is the whole row minus one column, not an empty object.
    expect(projected).toContain("webhookUrl");
    expect(projected.length).toBe(Object.keys(getTableColumns(signOrgSettings)).length - 1);
  });
});

describe("SignSettingsService.get — reads without writing because a GET request transaction is read-only", () => {
  beforeEach(() => jest.resetAllMocks());

  it("returns the existing row when one is found, without calling insert", async () => {
    const findFirst = jest.fn().mockResolvedValue(fullRow());
    const insert = jest.fn();
    const db = { query: { signOrgSettings: { findFirst } }, insert } as unknown as Db;

    const result = await new SignSettingsService(db, auditStub()).get(ORG);

    expect(insert).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(result.orgId).toBe(ORG);
  });

  it("returns in-memory defaults without calling insert when no row exists yet — the first PATCH creates it", async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const insert = jest.fn();
    const db = { query: { signOrgSettings: { findFirst } }, insert } as unknown as Db;

    const result = await new SignSettingsService(db, auditStub()).get(ORG);

    expect(insert).not.toHaveBeenCalled();
    expect(result.orgId).toBe(ORG);
    expect(result.defaultExpirationDays).toBe(30);
  });

  it("excludes webhookSecret from the column set on the findFirst call", async () => {
    const findFirst = jest.fn().mockResolvedValue(fullRow());
    const db = { query: { signOrgSettings: { findFirst } } } as unknown as Db;

    await new SignSettingsService(db, auditStub()).get(ORG);

    const [args] = findFirst.mock.calls[0] ?? [];
    const columns = (args as { columns?: Record<string, boolean> } | undefined)?.columns;
    expect(columns).toBeDefined();
    expect(columns?.webhookSecret).toBe(false);
  });

  it("never carries webhookSecret in the synthesised defaults row", async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const db = { query: { signOrgSettings: { findFirst } } } as unknown as Db;

    const result = await new SignSettingsService(db, auditStub()).get(ORG);

    expect(result).not.toHaveProperty("webhookSecret");
  });
});

describe("SignSettingsService.update — the webhook secret is never returned", () => {
  beforeEach(() => jest.resetAllMocks());

  it("excludes webhookSecret from the update projection", async () => {
    let returningArg: unknown;
    const findFirst = jest.fn().mockResolvedValue(fullRow());
    const db = {
      query: { signOrgSettings: { findFirst } },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockImplementation((arg: unknown) => {
              returningArg = arg;
              return Promise.resolve([fullRow()]);
            }),
          }),
        }),
      }),
    } as unknown as Db;

    await new SignSettingsService(db, auditStub()).update(ORG, { maxFileSizeMb: 10 });

    expect(returningArg).toBeDefined();
    const projected = Object.keys(returningArg as Record<string, unknown>);
    expect(projected).not.toContain("webhookSecret");
    expect(projected).toContain("maxFileSizeMb");
  });
});
