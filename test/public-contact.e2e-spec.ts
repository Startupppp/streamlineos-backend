import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AllExceptionsFilter } from "src/common/http/all-exceptions.filter";
import { RateLimitGuard } from "src/common/ratelimit/rate-limit.guard";
import { RateLimitService } from "src/common/ratelimit/rate-limit.service";
import { EmailService } from "src/modules/email/email.service";
import { ContactService } from "src/modules/public/contact.service";
import { CrmService } from "src/modules/public/crm.service";
import { IntakeService } from "src/modules/public/intake.service";
import { KbService } from "src/modules/public/kb.service";
import { OrgService } from "src/modules/public/org.service";
import { PublicController } from "src/modules/public/public.controller";
import { PublicFormsService } from "src/modules/public/public-forms.service";
import { RecruitmentService } from "src/modules/public/recruitment.service";
import { RoadmapService } from "src/modules/public/roadmap.service";

const validSubmission = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  company: "Analytical Engines",
  phone: "+44 20 7946 0958",
  topic: "sales",
  message: "I would like to discuss an enterprise rollout.",
};

describe("Public contact form (e2e)", () => {
  let app: INestApplication;
  const sendEmail = jest.fn<Promise<void>, [unknown]>();
  const checkRateLimit = jest.fn();

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    process.env.CONTACT_NOTIFICATION_EMAIL = "contact-inbox@example.com";
    delete process.env.TURNSTILE_SECRET_KEY;

    const moduleRef = await Test.createTestingModule({
      controllers: [PublicController],
      providers: [
        RateLimitGuard,
        { provide: RateLimitService, useValue: { check: checkRateLimit } },
        { provide: EmailService, useValue: { sendEmail } },
        ContactService,
        { provide: RecruitmentService, useValue: {} },
        { provide: RoadmapService, useValue: {} },
        { provide: KbService, useValue: {} },
        { provide: CrmService, useValue: {} },
        { provide: IntakeService, useValue: {} },
        { provide: OrgService, useValue: {} },
        { provide: PublicFormsService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
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
