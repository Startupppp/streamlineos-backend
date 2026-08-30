import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { SignPublicFormService } from "./sign-public-form.service";

jest.mock("../../common/tenant/with-public-token");
jest.mock("../../common/tenant/run-in-tenant-transaction");

import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

const OWNER_ORG = "org-owner";
const OTHER_ORG = "org-other";

describe("SignPublicFormService — cross-tenant isolation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("submitPublicForm: throws NotFoundException when the form is not published (deny — slug from wrong org or missing)", async () => {
    jest.mocked(withPublicToken).mockResolvedValue(null as never);
    const db = {} as unknown as Db;
    const tokens = {} as never;
    const audit = {} as never;
    const templates = {} as never;
    const settings = {} as never;
    const svc = new SignPublicFormService(db, tokens, audit, templates, settings);
    await expect(
      svc.submitPublicForm("slug-x", { name: "Alice", email: "a@b.com" } as never, {}),
    ).rejects.toThrow(NotFoundException);
    expect(jest.mocked(withPublicToken)).toHaveBeenCalledWith(db, "slug-x", expect.any(Function));
  });

  it("submitPublicForm: uses the form.orgId (not a caller-supplied value) for the tenant transaction (control — org isolated via form)", async () => {
    const form = {
      id: 1,
      orgId: OWNER_ORG,
      status: "published",
      expiresAt: null,
      maxSubmissions: null,
      submissionCount: 0,
      accessCodeHash: null,
      completionRedirectUrl: null,
      templateId: 42,
      createdBy: "creator-1",
    };
    jest.mocked(withPublicToken).mockResolvedValue(form as never);

    const recipient = { id: "rec-1", envelopeId: "env-1" };
    const envelope = { id: "env-1" };
    const capturedOpts: { orgId?: string } = {};
    jest.mocked(runInTenantTransaction).mockImplementation(
      async (_db, _cb, opts) => {
        Object.assign(capturedOpts, opts);
        return {};
      },
    );

    const templates = {
      getPublicForm: jest.fn(),
      get: jest.fn().mockResolvedValue({
        templateJson: JSON.stringify({ roles: [{ roleName: "Signer", recipientType: "signer" }] }),
        ownerUserId: "owner-1",
      }),
      instantiate: jest.fn().mockResolvedValue(envelope),
    } as never;

    const settings = {
      getOrCreate: jest.fn().mockResolvedValue({ defaultExpirationDays: 30 }),
    } as never;

    const tokens = {
      hash: jest.fn().mockReturnValue("hashed"),
      generateSigningToken: jest.fn().mockReturnValue("raw-token"),
    } as never;

    const audit = { record: jest.fn().mockResolvedValue(undefined) } as never;
    const db = {} as unknown as Db;

    const svc = new SignPublicFormService(db, tokens, audit, templates, settings);
    await svc.submitPublicForm(
      "slug-owner",
      { name: "Bob", email: "b@c.com" } as never,
      { ipAddress: "1.2.3.4" },
    );

    expect(capturedOpts.orgId).toBe(OWNER_ORG);
    expect(capturedOpts.orgId).not.toBe(OTHER_ORG);
  });
});
