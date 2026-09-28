import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { withPublicToken } from "../../../common/tenant/with-public-token";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { KbPagePublicService } from "./kb-page-public.service";
import { hashPublicToken } from "./kb-public-token";

jest.mock("../../../common/tenant/with-public-token", () => ({
  withPublicToken: jest.fn(),
}));
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
  runInTenantTransaction: jest.fn(),
}));

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

const withPublicTokenMock = withPublicToken as jest.MockedFunction<typeof withPublicToken>;
const runInNewTenantTransactionMock = runInNewTenantTransaction as jest.MockedFunction<
  typeof runInNewTenantTransaction
>;

const dialect = new PgDialect();

function renderedQuery(condition: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(condition as SQL);
}

function makeService(): KbPagePublicService {
  return new KbPagePublicService({} as never, {} as never, {} as never, {} as never);
}

const PAGE_A = { orgId: "org-tenant-a", id: 7 };

beforeEach(() => {
  jest.clearAllMocks();
  withPublicTokenMock.mockImplementation(async (_db, _token, fn) =>
    fn({ query: { kbPages: { findFirst: async () => PAGE_A } } } as never),
  );
});

describe("KbPagePublicService.validatePublicAttachment — page-id key-ownership binding", () => {
  it("positive control: returns the file key when the attachment belongs to the page that the token resolves to", async () => {
    let capturedOpts: unknown;
    runInNewTenantTransactionMock.mockImplementation(async (_db, _orgId, fn) =>
      fn({
        query: {
          kbPageAttachments: {
            findFirst: async (opts: unknown) => {
              capturedOpts = opts;
              return { fileKey: "org-tenant-a/img.png" };
            },
          },
        },
      } as never),
    );

    const result = await makeService().validatePublicAttachment("token-a", "org-tenant-a/img.png");
    expect(result.fileKey).toBe("org-tenant-a/img.png");

    const bound = sqlValues((capturedOpts as { where?: unknown })?.where);
    expect(bound).toContain(PAGE_A.id);
  });

  it("binds the page-id from the token-validated page into the attachment WHERE clause so a missing pageId filter would leave the id absent", async () => {
    let capturedOpts: unknown;
    runInNewTenantTransactionMock.mockImplementation(async (_db, _orgId, fn) =>
      fn({
        query: {
          kbPageAttachments: {
            findFirst: async (opts: unknown) => {
              capturedOpts = opts;
              return undefined;
            },
          },
        },
      } as never),
    );

    await expect(
      makeService().validatePublicAttachment("token-a", "other/file.png"),
    ).rejects.toThrow(NotFoundException);

    const bound = sqlValues((capturedOpts as { where?: unknown })?.where);
    expect(bound).toContain(PAGE_A.id);
  });

  it("passes the orgId from the page row to runInNewTenantTransaction so the attachment lookup is tenant-scoped to the page owner", async () => {
    runInNewTenantTransactionMock.mockImplementation(async (_db, _orgId, fn) =>
      fn({
        query: {
          kbPageAttachments: {
            findFirst: async () => ({ fileKey: "org-tenant-a/img.png" }),
          },
        },
      } as never),
    );

    await makeService().validatePublicAttachment("token-a", "org-tenant-a/img.png");

    expect(runInNewTenantTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      PAGE_A.orgId,
      expect.any(Function),
    );
  });

  it("does not call runInNewTenantTransaction when the page is not found, so no attachment lookup happens for an invalid token", async () => {
    withPublicTokenMock.mockImplementation(async (_db, _token, fn) =>
      fn({ query: { kbPages: { findFirst: async () => undefined } } } as never),
    );

    await expect(
      makeService().validatePublicAttachment("bad-token", "org/file.png"),
    ).rejects.toThrow(NotFoundException);

    expect(runInNewTenantTransactionMock).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when the token resolves a page but the file key has no matching attachment on that page", async () => {
    runInNewTenantTransactionMock.mockImplementation(async (_db, _orgId, fn) =>
      fn({
        query: {
          kbPageAttachments: { findFirst: async () => undefined },
        },
      } as never),
    );

    await expect(
      makeService().validatePublicAttachment("token-a", "org-tenant-a/nonexistent.png"),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("KbPagePublicService.validatePublicAttachment — page-level grant predicates mirror getPublicPage", () => {
  const RAW_TOKEN = "grant-binding-probe-token-001";
  const EXPECTED_HASH = hashPublicToken(RAW_TOKEN);

  let capturedPageWhere: unknown;

  beforeEach(() => {
    capturedPageWhere = undefined;
    withPublicTokenMock.mockImplementation(async (_db, _token, fn) =>
      fn({
        query: {
          kbPages: {
            findFirst: async (opts: { where?: unknown }) => {
              capturedPageWhere = opts.where;
              return PAGE_A;
            },
          },
        },
      } as never),
    );
    runInNewTenantTransactionMock.mockImplementation(async (_db, _orgId, fn) =>
      fn({
        query: {
          kbPageAttachments: {
            findFirst: async () => ({ fileKey: "org-tenant-a/img.png" }),
          },
        },
      } as never),
    );
  });

  it("positive control: returns the file key when token hash, visibility, status and soft-delete all pass so the guard assertions below are not vacuous", async () => {
    const result = await makeService().validatePublicAttachment(RAW_TOKEN, "org-tenant-a/img.png");
    expect(result.fileKey).toBe("org-tenant-a/img.png");
    expect(capturedPageWhere).toBeDefined();
  });

  it("passes the hash of the raw token to withPublicToken so the RLS GUC matches the page-lookup predicate and the raw bearer credential never reaches the database", async () => {
    await makeService().validatePublicAttachment(RAW_TOKEN, "org-tenant-a/img.png");
    expect(withPublicTokenMock).toHaveBeenCalledWith(expect.anything(), EXPECTED_HASH, expect.any(Function));
    expect(withPublicTokenMock).not.toHaveBeenCalledWith(expect.anything(), RAW_TOKEN, expect.any(Function));
  });

  it("binds the token hash into the page WHERE clause so revoking the share (which nulls public_token_hash) also blocks attachment access for the same token", async () => {
    await makeService().validatePublicAttachment(RAW_TOKEN, "org-tenant-a/img.png");
    const q = renderedQuery(capturedPageWhere);
    expect(q.params).toContain(EXPECTED_HASH);
    expect(q.params).not.toContain(RAW_TOKEN);
  });

  it("the page WHERE clause requires visibility=public so clearing the share to private or org also blocks attachment access through the same token", async () => {
    await makeService().validatePublicAttachment(RAW_TOKEN, "org-tenant-a/img.png");
    const q = renderedQuery(capturedPageWhere);
    expect(q.sql).toMatch(/visibility/);
    expect(q.params).toContain("public");
  });

  it("the page WHERE clause requires status=published so draft and archived pages cannot serve their attachments through a public link", async () => {
    await makeService().validatePublicAttachment(RAW_TOKEN, "org-tenant-a/img.png");
    const q = renderedQuery(capturedPageWhere);
    expect(q.sql).toMatch(/status/);
    expect(q.params).toContain("published");
  });

  it("the page WHERE clause requires deleted_at IS NULL so soft-deleted pages cannot serve their attachments after deletion", async () => {
    await makeService().validatePublicAttachment(RAW_TOKEN, "org-tenant-a/img.png");
    const q = renderedQuery(capturedPageWhere);
    expect(q.sql).toMatch(/deleted_at/);
    expect(q.sql).toMatch(/is null/);
  });
});
