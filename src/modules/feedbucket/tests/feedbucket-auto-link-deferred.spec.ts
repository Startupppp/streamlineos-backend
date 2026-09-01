const mockRegisterAfterCommit = jest.fn<boolean, [() => Promise<unknown>]>();
const mockRunInNewTenantTransaction = jest.fn();
const mockRunInTenantTransaction = jest.fn();

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (...args: unknown[]) => mockRunInTenantTransaction(...args),
  runInNewTenantTransaction: (...args: unknown[]) => mockRunInNewTenantTransaction(...args),
}));
jest.mock("../../../common/tenant/tenant-context", () => ({
  registerAfterCommit: (fn: () => Promise<unknown>) => mockRegisterAfterCommit(fn),
}));

import { FeedbucketPublicController } from "../feedbucket-public.controller";
import type { Db } from "../../../db/drizzle.module";

const VALID_BODY = {
  type: "bug",
  message: "Something is broken here",
  pageUrl: "https://app.example.com",
  metadata: {},
};

const baseWidget = {
  id: 1,
  orgId: "org_1",
  publicKey: "fb_key_1",
  name: "Bug Widget",
  projectId: 10,
  managedProductId: null,
  autoCreateTicket: true,
  aiAssistEnabled: false,
  defaultTicketType: "BUG",
  allowedDomains: [],
  isActive: true,
  createdBy: "user_creator",
  deletedAt: null,
  theme: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeDb(): Db {
  return {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 42 }]),
      }),
    }),
  } as unknown as Db;
}

function makeController() {
  const db = makeDb();
  const publicService = { resolveWidget: jest.fn().mockResolvedValue(baseWidget), createSubmission: jest.fn().mockResolvedValue(42) };
  const aiService = {};
  const storage = { uploadCompressed: jest.fn(), uploadBuffer: jest.fn() };
  const notifications = { create: jest.fn().mockResolvedValue(undefined) };
  const rateLimitService = { check: jest.fn().mockResolvedValue({ allowed: true }) };
  const ticketsService = { createFromFeedback: jest.fn().mockResolvedValue({ id: 99 }) };

  const ctrl = new FeedbucketPublicController(
    publicService as never,
    aiService as never,
    storage as never,
    notifications as never,
    rateLimitService as never,
    ticketsService as never,
    db,
  );
  return { ctrl, publicService, ticketsService, rateLimitService };
}

const fakeReq = { ip: "1.2.3.4", headers: {} };

describe("FeedbucketPublicController.autoLinkTicket — deferred after-commit pattern (D4)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunInTenantTransaction.mockImplementation(
      (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts: unknown) =>
        fn({}),
    );
    mockRunInNewTenantTransaction.mockImplementation(
      (_db: unknown, _orgId: string, fn: () => Promise<unknown>) => fn(),
    );
  });

  it("registers the ticket-link work via registerAfterCommit (not void fire-and-forget)", async () => {
    mockRegisterAfterCommit.mockReturnValue(true);
    const { ctrl } = makeController();

    await ctrl.submit("fb_key_1", VALID_BODY as never, { screenshot: undefined, recording: undefined }, fakeReq as never);

    expect(mockRegisterAfterCommit).toHaveBeenCalledTimes(1);
    expect(typeof mockRegisterAfterCommit.mock.calls[0]?.[0]).toBe("function");
  });

  it("falls back to inline execution when registerAfterCommit returns false (no ambient context)", async () => {
    mockRegisterAfterCommit.mockReturnValue(false);
    const { ctrl } = makeController();

    await ctrl.submit("fb_key_1", VALID_BODY as never, { screenshot: undefined, recording: undefined }, fakeReq as never);

    await Promise.resolve();
    await Promise.resolve();

    expect(mockRegisterAfterCommit).toHaveBeenCalledTimes(1);
    expect(mockRunInNewTenantTransaction).toHaveBeenCalled();
    expect(mockRunInNewTenantTransaction.mock.calls[0]?.[1]).toBe("org_1");
  });

  it("the deferred hook opens a new tenant transaction for org_1", async () => {
    let capturedHook: (() => Promise<unknown>) | undefined;
    mockRegisterAfterCommit.mockImplementation((fn) => {
      capturedHook = fn;
      return true;
    });
    const { ctrl } = makeController();

    await ctrl.submit("fb_key_1", VALID_BODY as never, { screenshot: undefined, recording: undefined }, fakeReq as never);

    expect(capturedHook).toBeDefined();
    await capturedHook!();

    expect(mockRunInNewTenantTransaction).toHaveBeenCalledTimes(1);
    expect(mockRunInNewTenantTransaction.mock.calls[0]?.[1]).toBe("org_1");
  });

  it("does NOT call registerAfterCommit when autoCreateTicket is false", async () => {
    const { ctrl, publicService } = makeController();
    publicService.resolveWidget.mockResolvedValue({ ...baseWidget, autoCreateTicket: false });

    await ctrl.submit("fb_key_1", VALID_BODY as never, { screenshot: undefined, recording: undefined }, fakeReq as never);

    expect(mockRegisterAfterCommit).not.toHaveBeenCalled();
    expect(mockRunInNewTenantTransaction).not.toHaveBeenCalled();
  });

  it("does NOT call registerAfterCommit when projectId is null", async () => {
    const { ctrl, publicService } = makeController();
    publicService.resolveWidget.mockResolvedValue({ ...baseWidget, projectId: null });

    await ctrl.submit("fb_key_1", VALID_BODY as never, { screenshot: undefined, recording: undefined }, fakeReq as never);

    expect(mockRegisterAfterCommit).not.toHaveBeenCalled();
  });
});
