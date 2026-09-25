import { NotFoundException } from "@nestjs/common";
import { withPublicToken } from "../../../common/tenant/with-public-token";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { KbPagesService } from "./kb-pages.service";

jest.mock("../../../common/tenant/with-public-token", () => ({
  withPublicToken: jest.fn(),
}));
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

const withPublicTokenMock = withPublicToken as jest.MockedFunction<typeof withPublicToken>;
const runInNewTenantTransactionMock = runInNewTenantTransaction as jest.MockedFunction<
  typeof runInNewTenantTransaction
>;

function makeService(): KbPagesService {
  return new KbPagesService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  withPublicTokenMock.mockResolvedValue(undefined);
  runInNewTenantTransactionMock.mockResolvedValue(undefined);
});

describe("KbPagesService.validatePublicAttachment", () => {
  it("throws NotFoundException when the token does not match a public page", async () => {
    withPublicTokenMock.mockResolvedValue(undefined as never);

    const svc = makeService();
    await expect(svc.validatePublicAttachment("bad-token", "org/file.png")).rejects.toThrow(
      NotFoundException,
    );
  });

  it("throws NotFoundException when the attachment does not belong to the page", async () => {
    withPublicTokenMock.mockImplementation(async (_db, _token, fn) =>
      fn({ query: { kbPages: { findFirst: async () => ({ orgId: "org1", id: 7 }) } } } as never),
    );
    runInNewTenantTransactionMock.mockImplementation(async (_db, _orgId, fn) =>
      fn({ query: { kbPageAttachments: { findFirst: async () => undefined } } } as never),
    );

    const svc = makeService();
    await expect(svc.validatePublicAttachment("good-token", "org1/missing.png")).rejects.toThrow(
      NotFoundException,
    );
  });

  it("returns the fileKey when the page token is valid and the attachment belongs to that page", async () => {
    withPublicTokenMock.mockImplementation(async (_db, _token, fn) =>
      fn({ query: { kbPages: { findFirst: async () => ({ orgId: "org1", id: 7 }) } } } as never),
    );
    runInNewTenantTransactionMock.mockImplementation(async (_db, _orgId, fn) =>
      fn({
        query: {
          kbPageAttachments: { findFirst: async () => ({ fileKey: "org1/image.png" }) },
        },
      } as never),
    );

    const svc = makeService();
    const key = await svc.validatePublicAttachment("good-token", "org1/image.png");
    expect(key).toBe("org1/image.png");
  });

  it("passes the orgId from the page row to runInNewTenantTransaction", async () => {
    withPublicTokenMock.mockImplementation(async (_db, _token, fn) =>
      fn({ query: { kbPages: { findFirst: async () => ({ orgId: "org-xyz", id: 42 }) } } } as never),
    );
    runInNewTenantTransactionMock.mockImplementation(async (_db, _orgId, fn) =>
      fn({
        query: {
          kbPageAttachments: { findFirst: async () => ({ fileKey: "org-xyz/img.jpg" }) },
        },
      } as never),
    );

    const svc = makeService();
    await svc.validatePublicAttachment("tok", "org-xyz/img.jpg");

    expect(runInNewTenantTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      "org-xyz",
      expect.any(Function),
    );
  });
});
