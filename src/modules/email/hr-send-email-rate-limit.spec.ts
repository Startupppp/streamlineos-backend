import { HrSendEmailController } from "./controllers/hr-send-email.controller";
import { RateLimitService, effectiveRateLimit } from "../../common/ratelimit/rate-limit.service";
import { RATE_LIMIT_TIER } from "../../common/ratelimit/use-rate-limit.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import type { AuditService } from "../../common/audit/audit.service";
import type { Db } from "../../db/drizzle.module";
import type { EmailService } from "./email.service";
import type { EmailProviderService } from "./email.provider";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

/**
 * `POST /hr/integrations/send-email` takes an arbitrary To:, an arbitrary subject
 * and arbitrary HTML, and sends it from the platform's own sender. Its sibling
 * `POST /settings/email-templates/test` has carried a limiter and an audit entry
 * since it could aim that sender anywhere; this route could do the same with a
 * free-form body and had neither. One holder of `hr:communications:send` could
 * empty the provider quota, and nothing recorded who mailed whom.
 */
const user: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
} as unknown as CurrentUserContext;

function makeController(audit: { log: jest.Mock }) {
  const db = {
    query: {
      emailTemplates: { findFirst: jest.fn().mockResolvedValue(undefined) },
      candidates: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
  } as unknown as Db;
  const emailService = { sendEmail: jest.fn().mockResolvedValue(undefined) };
  const emailProvider = { getEmailProvider: jest.fn().mockReturnValue("resend") };
  const controller = new HrSendEmailController(
    db,
    emailService as unknown as EmailService,
    emailProvider as unknown as EmailProviderService,
    audit as unknown as AuditService,
  );
  return { controller, emailService };
}

describe("hr send-email hardening", () => {
  it("declares a rate-limit tier and mounts the guard that reads it", () => {
    const tier = Reflect.getMetadata(RATE_LIMIT_TIER, HrSendEmailController.prototype.send);
    expect(tier).toBe("hr:communications-send");

    const guards: unknown[] =
      Reflect.getMetadata(GUARDS_METADATA, HrSendEmailController.prototype.send) ?? [];
    expect(guards).toContain(RateLimitGuard);
  });

  it("registers that tier, so the limiter actually bounds the route", async () => {
    const service = new RateLimitService(null);
    const identifier = `spec-${Date.now()}-${Math.random()}`;
    // Outside production every tier is multiplied, so a test hard-coding the
    // declared limit exhausts a tenth of the budget and never sees a 429.
    const budget = effectiveRateLimit("hr:communications-send");
    expect(budget).toBeGreaterThan(0);

    const first = await service.check("hr:communications-send", identifier);
    expect(first.allowed).toBe(true);

    let denied = false;
    for (let i = 0; i < budget + 5 && !denied; i++) {
      const result = await service.check("hr:communications-send", identifier);
      denied = !result.allowed;
    }
    expect(denied).toBe(true);
  });

  it("denies an unregistered tier, which is what makes the registration load-bearing", async () => {
    const service = new RateLimitService(null);
    const result = await service.check("hr:communications-send-typo", `spec-${Math.random()}`);
    expect(result.allowed).toBe(false);
  });

  it("records who mailed whom", async () => {
    const audit = { log: jest.fn() };
    const { controller, emailService } = makeController(audit);

    await controller.send(
      { to: "candidate@example.com", subject: "Interview", body: "<p>Hi</p>" },
      user,
    );

    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls[0]?.[0]).toMatchObject({
      action: "hr.communications.send",
      userId: "user-1",
      orgId: "org-1",
      resourceId: "candidate@example.com",
    });
  });

  it("writes no audit entry when the send never happened", async () => {
    const audit = { log: jest.fn() };
    const noProvider = new HrSendEmailController(
      { query: {} } as unknown as Db,
      { sendEmail: jest.fn() } as unknown as EmailService,
      { getEmailProvider: () => "none" } as unknown as EmailProviderService,
      audit as unknown as AuditService,
    );

    await expect(
      noProvider.send({ to: "a@example.com", subject: "s", body: "b" }, user),
    ).rejects.toThrow();
    expect(audit.log).not.toHaveBeenCalled();
  });
});
