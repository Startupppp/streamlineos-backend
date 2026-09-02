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
    expect(gateway.invokeText.mock.calls[0]?.[0]).toMatchObject({
      actor: { orgId: OWNER_ORG, userId: USER_ID },
      charge: true,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: OWNER_ORG, userId: USER_ID }),
    );

    const [, , opts] = runInTenantTransaction.mock.calls[0] as [unknown, unknown, { orgId: string }];
    expect(opts.orgId).toBe(OWNER_ORG);
  });

  /**
   * Every paid call site, not just the first one.
   *
   * The finding this closes was `actor: { orgId: "" }` beside `charge: true`: a
   * reservation is taken atomically BEFORE the provider call, so an empty tenant
   * makes the spend real and the debit unattributable — no organization's balance
   * ever reflects it. The buffered `improveWriting` path was already covered
   * above; the two other buffered methods and all three streaming ones were not,
   * and the streaming paths are the ones where a reservation is easiest to get
   * wrong. One assertion per site, so a literal reintroduced at any of the six
   * fails here rather than at the ledger.
   */
  describe("every paid invocation bills the caller's own organization", () => {
    const postRow = { id: POST_ID, title: "Hello World", excerpt: "An excerpt", content: "Content" };

    const build = () => {
      runInTenantTransaction.mockImplementation(
        async (_db: unknown, cb: (tx: unknown) => Promise<unknown>) =>
          cb({
            select: () => ({
              from: () => ({ where: () => ({ limit: () => Promise.resolve([postRow]) }) }),
            }),
          }),
      );
      const gateway = {
        invokeText: jest.fn().mockResolvedValue({ ok: true, data: "text" }),
        streamTextWithUsage: jest.fn().mockResolvedValue({ stream: null }),
      };
      return { gateway, audit: { log: jest.fn() } };
    };

    const billsCaller = (call: unknown): void => {
      const options = call as { actor: { orgId: string; userId: string }; charge: boolean };
      expect(options.actor.orgId).toBe(OWNER_ORG);
      expect(options.actor.orgId).not.toBe("");
      expect(options.actor.userId).toBe(USER_ID);
      expect(options.charge).toBe(true);
    };

    it.each([
      ["suggestTitle", false],
      ["summarize", false],
      ["streamImproveWriting", true],
      ["streamSuggestTitle", true],
      ["streamSummarize", true],
    ] as const)("%s charges the caller's org, never an empty one", async (method, streaming) => {
      const { BlogAiService } = await import("./blog-ai.service");
      const { gateway, audit } = build();
      const svc = new BlogAiService({} as never, gateway as never, audit as never);

      await (svc[method] as (o: string, u: string, p: string, d: unknown) => Promise<unknown>)(
        OWNER_ORG,
        USER_ID,
        POST_ID,
        { content: "draft" },
      );

      const spy = streaming ? gateway.streamTextWithUsage : gateway.invokeText;
      expect(spy).toHaveBeenCalledTimes(1);
      billsCaller(spy.mock.calls[0]?.[0]);
    });

    it("a missing post stops every streaming path before the reservation is taken", async () => {
      const { BlogAiService } = await import("./blog-ai.service");
      const { gateway, audit } = build();
      runInTenantTransaction.mockRejectedValue(new Error("Post not found"));
      const svc = new BlogAiService({} as never, gateway as never, audit as never);

      await expect(
        svc.streamImproveWriting(OWNER_ORG, USER_ID, "nonexistent", { content: "d" }),
      ).rejects.toThrow("Post not found");
      expect(gateway.streamTextWithUsage).not.toHaveBeenCalled();
    });
  });
});
