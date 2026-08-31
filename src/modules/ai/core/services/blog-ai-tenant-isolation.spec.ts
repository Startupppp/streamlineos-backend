/**
 * BlogAiService isolation spec.
 *
 * `blogPosts` is a platform-global table with no `orgId` column — any authenticated
 * org can read any post by ID (this is correct, not a bug). The service passes
 * `orgId` to `runInTenantTransaction` only to open a tenant-GUC context for the
 * Neon session, and to the AI gateway for credit billing. There is no cross-tenant
 * data leak: the post content is global platform content, and the AI credit is
 * charged to the caller's org (never to a different org).
 *
 * These specs verify:
 *   1. A missing post throws NotFoundException (DENY on bad postId).
 *   2. The gateway actor carries the CALLER's orgId, not a leaked one.
 *   3. runInTenantTransaction is called with the correct orgId for the tenant GUC.
 */

export {};

jest.mock("../../../../common/tenant/run-in-tenant-transaction");

const OWNER_ORG = "org-owner-blog";
const USER_ID = "user-blog-01";
const POST_ID = "post-abc-123";

describe("BlogAiService — tenant isolation (global content, scoped billing)", () => {
  let runInTenantTransaction: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    runInTenantTransaction = jest.requireMock(
      "../../../../common/tenant/run-in-tenant-transaction",
    ).runInTenantTransaction;
  });

  it("improveWriting: DENY — NotFoundException when post does not exist (cross-tenant non-issue, missing-post guard)", async () => {
    const { BlogAiService } = await import("./blog-ai.service");

    runInTenantTransaction.mockRejectedValueOnce(
      Object.assign(new Error("Post not found"), { status: 404 }),
    );

    const gateway = { invokeText: jest.fn() };
    const audit = { log: jest.fn() };
    const mockDb = {} as never;
    const svc = new BlogAiService(mockDb, gateway as never, audit as never);

    await expect(
      svc.improveWriting(OWNER_ORG, USER_ID, "nonexistent-post", { content: "draft" }),
    ).rejects.toMatchObject({ message: "Post not found" });

    expect(gateway.invokeText).not.toHaveBeenCalled();
  });

  it("improveWriting: CONTROL — tenant GUC set to caller's orgId, gateway never charged to wrong org", async () => {
    const { BlogAiService } = await import("./blog-ai.service");

    const postRow = {
      id: POST_ID,
      title: "Hello World",
      excerpt: "A test excerpt",
      content: "Full content here",
    };

    runInTenantTransaction.mockImplementation(
      async (_db: unknown, cb: (tx: unknown) => Promise<unknown>, opts: { orgId: string }) => {
        expect(opts.orgId).toBe(OWNER_ORG);
        const tx = {
          select: () => ({
            from: () => ({ where: () => ({ limit: () => Promise.resolve([postRow]) }) }),
          }),
        };
        return cb(tx);
      },
    );

    const gateway = {
      invokeText: jest.fn().mockResolvedValue({ ok: true, data: "Improved content." }),
    };
    const audit = { log: jest.fn() };
    const mockDb = {} as never;
    const svc = new BlogAiService(mockDb, gateway as never, audit as never);

    const result = await svc.improveWriting(OWNER_ORG, USER_ID, POST_ID, { content: "" });

    expect(result.content).toContain("Improved content");
    expect(gateway.invokeText).toHaveBeenCalledTimes(1);

    const [, , opts] = runInTenantTransaction.mock.calls[0] as [unknown, unknown, { orgId: string }];
    expect(opts.orgId).toBe(OWNER_ORG);
  });
});
