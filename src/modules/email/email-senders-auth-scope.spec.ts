import { runWithTenantContext } from "../../common/tenant/tenant-context";
import { EmailOutboxService } from "./email-outbox.service";
import type { EmailDispatcher } from "./email-provider-selection";
import type { EmailSuppressionService } from "./email-suppression.service";
import { EmailService } from "./email.service";

interface RecordingDouble {
  readonly rows: Record<string, unknown>[];
  readonly email: EmailService;
}

function recordingEmailService(): RecordingDouble {
  const rows: Record<string, unknown>[] = [];
  const db = {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
        rows.push(row);
        return { returning: jest.fn().mockResolvedValue([{ id: "email-1" }]) };
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    }),
  };
  const provider: EmailDispatcher = {
    getEmailProvider: () => "zeptomail",
    sendEmailOnceDirect: () => Promise.resolve(),
    dispatchEmail: () => Promise.resolve(),
  };
  const suppression = {
    findSuppressed: jest.fn().mockResolvedValue(new Set<string>()),
  } as never as EmailSuppressionService;

  const outbox = new EmailOutboxService(db as never, suppression, provider);
  return { rows, email: new EmailService(outbox, provider as never) };
}

describe("auth mail sent before the recipient belongs to any tenant", () => {
  it("queues verification mail as PLATFORM rather than refusing it, because the public resend route establishes no tenant context", async () => {
    const { rows, email } = recordingEmailService();

    await email.sendVerificationEmail("new@example.com", "raw-token");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: null, scope: "PLATFORM" });
  });

  it("queues the email OTP as PLATFORM, because sign-in happens before the session names an organization", async () => {
    const { rows, email } = recordingEmailService();

    await email.sendEmailOtpEmail("new@example.com", "123456");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: null, scope: "PLATFORM" });
  });

  it("queues the magic link as PLATFORM, because the requester is unauthenticated and may belong to no organization at all", async () => {
    const { rows, email } = recordingEmailService();

    await email.sendMagicLinkEmail("new@example.com", "raw-token");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: null, scope: "PLATFORM" });
  });

  it("queues the lockout notice as PLATFORM, because it is sent on a failed login with no session to name a tenant", async () => {
    const { rows, email } = recordingEmailService();

    await email.sendAccountLockedEmail("new@example.com", "Ada");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: null, scope: "PLATFORM" });
  });

  it("still attributes a sign-in link to the tenant an admin sent it from, because the RLS WITH CHECK rejects a null organization while a tenant GUC is set", async () => {
    const { rows, email } = recordingEmailService();

    await runWithTenantContext(
      { orgId: "org-1", audience: "INTERNAL", tx: {} as never },
      () => email.sendMagicLinkEmail("member@example.com", "raw-token"),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: "org-1", scope: "TENANT" });
  });
});
