import { CronKbService } from "../cron-kb.service";
import type { Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant/for-each-org";
import { purgeSourceRemovedLinks } from "../../kb/linked-documents/kb-linked-document-purge";

jest.mock("../../../common/tenant/for-each-org", () => ({ forEachOrg: jest.fn() }));
jest.mock("../../kb/linked-documents/kb-linked-document-purge", () => ({ purgeSourceRemovedLinks: jest.fn() }));

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;
const mockedPurge = purgeSourceRemovedLinks as jest.MockedFunction<typeof purgeSourceRemovedLinks>;

const ORG_A = "org-aaaa-purge";
const ORG_B = "org-bbbb-purge";

function build() {
  const trash = { purgeExpired: jest.fn().mockResolvedValue(0) };
  const settings = { getOrgSettings: jest.fn().mockResolvedValue({ trashRetentionDays: 30 }) };
  const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
  const service = new CronKbService({} as unknown as Db, trash as never, settings as never, audit as never);
  const tx = {};
  mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
    await fn(tx as never, ORG_A);
    await fn(tx as never, ORG_B);
    return { organizations: 2, succeeded: 2, failed: 0 };
  });
  return { service, trash, audit, tx };
}

beforeEach(() => jest.resetAllMocks());

describe("CronKbService — purging HR-document entries", () => {
  it("clears each organisation's due entries inside that organisation's own transaction, and audits the ones that had any", async () => {
    const { service, audit, tx } = build();
    mockedPurge.mockImplementation(async (_tx, orgId) =>
      orgId === ORG_A ? { purged: 3, linkedDocumentIds: [4, 5, 6], truncated: false } : { purged: 0, linkedDocumentIds: [], truncated: false },
    );

    const result = await service.purgeExpiredTrash();

    expect(mockedPurge).toHaveBeenCalledWith(tx, ORG_A, expect.any(Date), 200);
    expect(mockedPurge).toHaveBeenCalledWith(tx, ORG_B, expect.any(Date), 200);
    expect(result.linkedDocumentsPurged).toBe(3);
    expect(audit.logCritical).toHaveBeenCalledTimes(1);
    expect(audit.logCritical).toHaveBeenCalledWith({
      action: "kb.hr_link.purged",
      systemActor: "cron:kb-trash-purge",
      orgId: ORG_A,
      targetId: ORG_A,
      targetType: "kb_linked_documents",
      metadata: { purged: 3, truncated: false, linkedDocumentIds: [4, 5, 6] },
    });
  });

  it("writes no audit row for an organisation with nothing due, so a tenant that never used the feature leaves no trace", async () => {
    const { service, audit } = build();
    mockedPurge.mockResolvedValue({ purged: 0, linkedDocumentIds: [], truncated: false });

    const result = await service.purgeExpiredTrash();

    expect(result.linkedDocumentsPurged).toBe(0);
    expect(audit.logCritical).not.toHaveBeenCalled();
  });

  it("still purges trashed pages exactly as before, and reports both counts", async () => {
    const { service, trash } = build();
    trash.purgeExpired.mockResolvedValueOnce(2).mockResolvedValueOnce(5);
    mockedPurge.mockResolvedValue({ purged: 1, linkedDocumentIds: [9], truncated: true });

    const result = await service.purgeExpiredTrash();

    expect(trash.purgeExpired).toHaveBeenCalledWith(ORG_A, expect.any(Date));
    expect(trash.purgeExpired).toHaveBeenCalledWith(ORG_B, expect.any(Date));
    expect(result).toEqual({ orgsProcessed: 2, purgedCount: 7, linkedDocumentsPurged: 2 });
  });
});
