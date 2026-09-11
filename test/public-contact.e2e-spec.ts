import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { AllExceptionsFilter } from "src/common/http/all-exceptions.filter";
import { ZodValidationInterceptor } from "src/common/validation/zod-validation.interceptor";
import { APP_CONFIG } from "src/config/config.module";
import { DRIZZLE } from "src/db/drizzle.constants";
import { RateLimitGuard } from "src/common/ratelimit/rate-limit.guard";
import { RateLimitService } from "src/common/ratelimit/rate-limit.service";
import { trustProxySetting } from "src/common/http/trust-proxy";
import { TurnstileService } from "src/common/security/turnstile.service";
import { EmailService } from "src/modules/email/email.service";
import { ContactService } from "src/modules/public/contact.service";
import type { AppConfig } from "src/config/env.validation";
import { CrmService } from "src/modules/public/crm.service";
import { IntakeService } from "src/modules/public/intake.service";
import { KbService } from "src/modules/public/kb.service";
import { OrgService } from "src/modules/public/org.service";
import { PublicCareersService } from "src/modules/public/public-careers.service";
import { PublicController } from "src/modules/public/public.controller";
import { PublicFormsService } from "src/modules/public/public-forms.service";
import { PublicOffersService } from "src/modules/public/public-offers.service";
import { PublicReferrersService } from "src/modules/public/public-referrers.service";
import { RoadmapService } from "src/modules/public/roadmap.service";
import { WaitlistService } from "src/modules/public/waitlist.service";
import { PublicPricingService } from "src/modules/public/pricing.service";

const validSubmission = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  company: "Analytical Engines",
  phone: "+44 20 7946 0958",
  topic: "sales",
  message: "I would like to discuss an enterprise rollout.",
};

describe("Public contact form (e2e)", () => {
  let app: NestExpressApplication;
  const sendEmail = jest.fn<Promise<void>, [unknown]>();
  const checkRateLimit = jest.fn();

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    process.env.CONTACT_NOTIFICATION_EMAIL = "contact-inbox@example.com";
    process.env.TRUST_PROXY_HOPS = "1";
    delete process.env.TURNSTILE_SECRET_KEY;

    const moduleRef = await Test.createTestingModule({
      controllers: [PublicController],
      providers: [
        RateLimitGuard,
        { provide: RateLimitService, useValue: { check: checkRateLimit } },
        { provide: EmailService, useValue: { sendEmail } },
        /**
         * A live view of `process.env`, not a snapshot.
         *
         * `ContactService` and `TurnstileService` read `APP_CONFIG` now, where
         * they used to read the environment directly — so this module stopped
         * resolving at all ("APP_CONFIG at index [0]"). The cases here still set
         * and delete `TURNSTILE_SECRET_KEY` between them, so a config object
         * captured when the module was built would freeze the first value and
         * quietly decide every case. The proxy keeps the reads live, which is
         * what those cases have always assumed.
         */
        {
          provide: APP_CONFIG,
          useValue: new Proxy(
            {},
            { get: (_target, key: string) => process.env[key] },
          ) as AppConfig,
        },
        TurnstileService,
        ContactService,
        { provide: PublicCareersService, useValue: {} },
        { provide: PublicOffersService, useValue: {} },
        { provide: PublicReferrersService, useValue: {} },
        { provide: RoadmapService, useValue: {} },
        { provide: WaitlistService, useValue: {} },
        { provide: KbService, useValue: {} },
        { provide: CrmService, useValue: {} },
        { provide: IntakeService, useValue: {} },
        { provide: OrgService, useValue: {} },
        { provide: PublicFormsService, useValue: {} },
        { provide: WaitlistService, useValue: {} },
        { provide: PublicPricingService, useValue: {} },
        { provide: DRIZZLE, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.set("trust proxy", trustProxySetting());
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ZodValidationInterceptor(app.get(Reflector)));
    await app.init();
  });

  beforeEach(() => {
    sendEmail.mockReset();
    sendEmail.mockResolvedValue();
    checkRateLimit.mockReset();
    checkRateLimit.mockResolvedValue({ allowed: true, retryAfterSecs: 0 });
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  afterAll(async () => {
    delete process.env.CONTACT_NOTIFICATION_EMAIL;
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TRUST_PROXY_HOPS;
    await app.close();
  });

  it("POST /public/contact accepts the landing form contract", async () => {
    const response = await request(app.getHttpServer())
      .post("/public/contact")
      .set("x-forwarded-for", "203.0.113.10")
      .send(validSubmission);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ ok: true });
    expect(checkRateLimit).toHaveBeenCalledWith("public:contact", "203.0.113.10");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "contact-inbox@example.com",
        replyTo: "ada@example.com",
      }),
    );
  });

  it("rejects unknown request fields", async () => {
    const response = await request(app.getHttpServer())
      .post("/public/contact")
      .send({ ...validSubmission, isAdmin: true });

    expect(response.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rejects requests over the public contact rate limit", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSecs: 3600 });

    const response = await request(app.getHttpServer())
      .post("/public/contact")
      .send(validSubmission);

    expect(response.status).toBe(429);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("requires bot verification when Turnstile is configured", async () => {
    process.env.TURNSTILE_SECRET_KEY = "turnstile-secret";

    const response = await request(app.getHttpServer())
      .post("/public/contact")
      .send(validSubmission);

    expect(response.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
