import "reflect-metadata";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { EmailTemplatesController } from "./controllers/email-templates.controller";
import { EmailRoutesService } from "./email-routes.service";
import { EmailService } from "./email.service";
import { TwilioGateway } from "./dispatch/twilio.gateway";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { RATE_LIMIT_TIER } from "../../common/ratelimit/use-rate-limit.decorator";
import { effectiveRateLimit } from "../../common/ratelimit/rate-limit.service";
import { AuditService } from "../../common/audit/audit.service";
import { humanSessionPrincipal } from "../../common/auth/principal";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { Db } from "../../db/drizzle.module";

/**
 * `POST /settings/email-templates/test` renders a platform template and sends
 * it. The handler took a body and nothing else: no @CurrentUser, no orgId, no
 * limiter, no audit — so any holder of settings:email-templates:manage, a key
 * the shipped HR_ADMIN template carries, could aim the platform's sending
 * identity at any address in the world, repeatedly and invisibly. No tenant
 * data crosses, so this is not a BOLA; it is an abusable send, and the asset at
 * risk is the platform's deliverability.
 *
 * Nothing here reaches a real mail provider: EmailService is a double that
 * records what it was asked to send.
 */

const ACTOR_EMAIL = "admin@tenant-one.example";

function actor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "ORG_ADMIN",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  } as CurrentUserContext;
}

function makeDb(accountEmail: string | null): Db {
  return {
    query: {
      users: {
        findFirst: jest
          .fn()
          .mockResolvedValue(accountEmail === null ? undefined : { email: accountEmail }),
      },
    },
  } as unknown as Db;
}

function makeService(accountEmail: string | null) {
  const sendEmail = jest.fn().mockResolvedValue(undefined);
  const routes = new EmailRoutesService(
    makeDb(accountEmail),
    { sendEmail } as unknown as EmailService,
    {} as unknown as TwilioGateway,
  );
  return { routes, sendEmail };
}

function firstTemplateId(): string {
  const { routes } = makeService(ACTOR_EMAIL);
  const previews = routes.getTemplatePreviews();
  const first = previews[0];
  if (!first) throw new Error("TEMPLATE_MAP is empty");
  return first.id;
}

beforeEach(() => jest.clearAllMocks());

describe("sendTemplateTest — the destination is the caller, not the body", () => {
  it("refuses an address that is not the caller's own, and sends nothing", async () => {
    const { routes, sendEmail } = makeService(ACTOR_EMAIL);
    await expect(
      routes.sendTemplateTest(actor(), firstTemplateId(), "victim@somewhere-else.example", "en"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends to the caller's own address, matched case-insensitively", async () => {
    const { routes, sendEmail } = makeService(ACTOR_EMAIL);
    const result = await routes.sendTemplateTest(
      actor(),
      firstTemplateId(),
      ` ${ACTOR_EMAIL.toUpperCase()} `,
      "en",
    );
    expect(result.sent).toBe(true);
    expect(result.to).toBe(ACTOR_EMAIL);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({ to: ACTOR_EMAIL });
  });

  it("stamps the caller's organisation on the send, so the outbox row is tenant-scoped", async () => {
    const { routes, sendEmail } = makeService(ACTOR_EMAIL);
    await routes.sendTemplateTest(actor(), firstTemplateId(), ACTOR_EMAIL, "en");
    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({
      organizationId: "org-1",
      recipientUserId: "user-1",
    });
  });

  it("refuses when the caller has no account row rather than falling through to the body address", async () => {
    const { routes, sendEmail } = makeService(null);
    await expect(
      routes.sendTemplateTest(actor(), firstTemplateId(), ACTOR_EMAIL, "en"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("still 404s an unknown template without sending", async () => {
    const { routes, sendEmail } = makeService(ACTOR_EMAIL);
    await expect(
      routes.sendTemplateTest(actor(), "does.not.exist", ACTOR_EMAIL, "en"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a caller in another organisation cannot borrow the first caller's address", async () => {
    const { routes, sendEmail } = makeService("someone-else@tenant-two.example");
    await expect(
      routes.sendTemplateTest(
        actor({ userId: "user-2", orgId: "org-2" }),
        firstTemplateId(),
        ACTOR_EMAIL,
        "en",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("the route around it — limiter and audit", () => {
  it("declares a rate-limit tier", () => {
    const tier: unknown = Reflect.getMetadata(
      RATE_LIMIT_TIER,
      EmailTemplatesController.prototype.test,
    );
    expect(typeof tier).toBe("string");
  });

  it("the declared tier is REGISTERED — an unregistered key is a limiter that is not one", () => {
    const tier = Reflect.getMetadata(
      RATE_LIMIT_TIER,
      EmailTemplatesController.prototype.test,
    ) as string;
    expect(effectiveRateLimit(tier)).toBeGreaterThan(0);
  });

  it("mounts the guard that reads the tier — a tier with no guard is decoration", () => {
    const guards: unknown = Reflect.getMetadata(
      "__guards__",
      EmailTemplatesController.prototype.test,
    );
    expect(Array.isArray(guards) ? guards : []).toContain(RateLimitGuard);
  });

  it("audits the send against the caller and their organisation", async () => {
    const { routes } = makeService(ACTOR_EMAIL);
    const log = jest.fn();
    const controller = new EmailTemplatesController(
      routes,
      { log } as unknown as AuditService,
    );
    await controller.test(
      { templateId: firstTemplateId(), testEmail: ACTOR_EMAIL, locale: "en" },
      actor(),
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      action: "settings.emailTemplate.test",
      userId: "user-1",
      orgId: "org-1",
    });
  });

  it("does not audit a refused send", async () => {
    const { routes } = makeService(ACTOR_EMAIL);
    const log = jest.fn();
    const controller = new EmailTemplatesController(
      routes,
      { log } as unknown as AuditService,
    );
    await expect(
      controller.test(
        { templateId: firstTemplateId(), testEmail: "victim@somewhere-else.example", locale: "en" },
        actor(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(log).not.toHaveBeenCalled();
  });
});
