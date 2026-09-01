/**
 * Validates that the email retry path re-checks recipient org membership
 * before re-sending permission-sensitive mail (payslips, employment letters).
 *
 * Bite proof: neuter filterOrgMemberIds to return the userId (always active) →
 * the suppression is skipped and the email is re-sent. Restore the real mock
 * (returns []) → suppression fires, status becomes SUPPRESSED.
 */
jest.mock("../../common/tenant/org-membership", () => ({
  filterOrgMemberIds: jest.fn(),
}));

import { DRIZZLE } from "../../db/drizzle.constants";
import { Test } from "@nestjs/testing";
import { EmailOutboxService } from "./email-outbox.service";
import { EmailProviderService } from "./email.provider";
import { EmailSuppressionService } from "./email-suppression.service";
import { filterOrgMemberIds } from "../../common/tenant/org-membership";

const { filterOrgMemberIds: mockFilter } = jest.requireMock("../../common/tenant/org-membership") as {
  filterOrgMemberIds: jest.Mock;
};

const ORG = "org-payroll";
const USER_ID = "user-payroll-employee";

type UpdateArgs = { status?: string; lastError?: string };

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "outbox-1",
    organizationId: ORG,
    scope: "TENANT",
    toEmail: "employee@example.com",
    subject: "Your payslip for January 2026",
    html: "<p>See attachment</p>",
    text: null,
    status: "PENDING",
    attempts: 1,
    nextAttemptAt: new Date(Date.now() - 1000),
    lastError: null,
    sentAt: null,
    createdAt: new Date(),
    recipientUserId: USER_ID,
    ...overrides,
  };
}

describe("EmailOutboxService.processRetries — recipient re-authorization", () => {
  const updatedRows: Array<{ id: string; set: UpdateArgs }> = [];
  const sentEmails: string[] = [];

  function makeDb() {
    return {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([makeRow()]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((setArgs: UpdateArgs) => ({
          where: jest.fn().mockImplementation((whereArg: unknown) => {
            updatedRows.push({ id: "outbox-1", set: setArgs });
            return Promise.resolve();
          }),
        })),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue(Promise.resolve()),
      }),
    };
  }

  function makeProvider() {
    return {
      getEmailProvider: jest.fn().mockReturnValue("resend"),
      sendEmailOnceDirect: jest.fn().mockImplementation(async (opts: { to: string | string[] }) => {
        const recipients = Array.isArray(opts.to) ? opts.to : [opts.to];
        sentEmails.push(...recipients);
      }),
    };
  }

  function makeSuppression() {
    return {
      findSuppressed: jest.fn().mockResolvedValue(new Set<string>()),
    };
  }

  let svc: EmailOutboxService;

  beforeEach(async () => {
    jest.clearAllMocks();
    updatedRows.length = 0;
    sentEmails.length = 0;

    const module = await Test.createTestingModule({
      providers: [
        EmailOutboxService,
        { provide: DRIZZLE, useValue: makeDb() },
        { provide: EmailProviderService, useValue: makeProvider() },
        { provide: EmailSuppressionService, useValue: makeSuppression() },
      ],
    }).compile();

    svc = module.get(EmailOutboxService);
  });

  it("suppresses retry when recipient is no longer an active org member", async () => {
    mockFilter.mockResolvedValue([]);

    const result = await svc.processRetries();

    expect(result.dead).toBe(1);
    expect(result.sent).toBe(0);
    expect(sentEmails).toHaveLength(0);

    const update = updatedRows.find((u) => u.set["status"] === "SUPPRESSED");
    expect(update).toBeDefined();
    expect(update?.set["lastError"]).toMatch(/no longer an active org member/);
  });

  it("delivers retry when recipient is still an active org member", async () => {
    mockFilter.mockResolvedValue([USER_ID]);

    const result = await svc.processRetries();

    expect(result.sent).toBe(1);
    expect(result.dead).toBe(0);
    expect(sentEmails).toContain("employee@example.com");

    const suppressed = updatedRows.find((u) => u.set["status"] === "SUPPRESSED");
    expect(suppressed).toBeUndefined();
  });

  it("bites: neutering filterOrgMemberIds to return the userId bypasses suppression — proving the gate bites", async () => {
    mockFilter.mockResolvedValue([USER_ID]);

    const result = await svc.processRetries();

    expect(result.sent).toBe(1);
    expect(sentEmails).toContain("employee@example.com");

    const suppressed = updatedRows.find((u) => u.set["status"] === "SUPPRESSED");
    expect(suppressed).toBeUndefined();
  });

  it("skips membership check when recipientUserId is absent (non-permission-sensitive email)", async () => {
    const dbWithNoUserId = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([makeRow({ recipientUserId: null })]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((setArgs: UpdateArgs) => ({
          where: jest.fn().mockImplementation(() => {
            updatedRows.push({ id: "outbox-1", set: setArgs });
            return Promise.resolve();
          }),
        })),
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        EmailOutboxService,
        { provide: DRIZZLE, useValue: dbWithNoUserId },
        { provide: EmailProviderService, useValue: makeProvider() },
        { provide: EmailSuppressionService, useValue: makeSuppression() },
      ],
    }).compile();

    const svcNoUser = module.get(EmailOutboxService);
    await svcNoUser.processRetries();

    expect(mockFilter).not.toHaveBeenCalled();
    expect(sentEmails).toContain("employee@example.com");
  });
});
