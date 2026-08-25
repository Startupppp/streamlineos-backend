import { Test } from "@nestjs/testing";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { DRIZZLE } from "../../db/drizzle.constants";
import { TurnstileService } from "../../common/security/turnstile.service";
import { EmailService } from "../email/email.service";
import { WaitlistService } from "./waitlist.service";
import type { WaitlistJoinInput } from "./dto/public.schemas";

const input: WaitlistJoinInput = {
  name: "Rohan Mehta",
  email: "rohan@example.com",
  organization: "Mehta Solutions",
  role: "Head of Operations",
  teamSize: "11-50",
  notes: "Spreadsheets everywhere.",
};

/**
 * `existingCode` is what a repeat signup looks like: the row already carried a
 * reference, so the one this call generated is not the one that comes back.
 * Omitting it echoes the generated code, which is the first-time case.
 */
function makeDb(
  row: { id: number; position: number; existingCode?: string },
) {
  let submitted: { publicCode?: string } = {};
  const returning = jest.fn().mockImplementation(() =>
    Promise.resolve([
      {
        id: row.id,
        publicCode: row.existingCode ?? submitted.publicCode,
        createdAt: new Date(),
      },
    ]),
  );
  const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
  const values = jest.fn().mockImplementation((v: { publicCode?: string }) => {
    submitted = v;
    return { onConflictDoUpdate };
  });
  const insert = jest.fn().mockReturnValue({ values });
  const where = jest.fn().mockResolvedValue([{ n: row.position }]);
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { db: { insert, select }, insert, values, onConflictDoUpdate, returning };
}

async function build(
  db: unknown,
  config: Partial<AppConfig> = {},
  sendEmail = jest.fn().mockResolvedValue(undefined),
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      WaitlistService,
      { provide: DRIZZLE, useValue: db },
      { provide: APP_CONFIG, useValue: config },
      { provide: EmailService, useValue: { sendEmail } },
      { provide: TurnstileService, useValue: { verify: jest.fn().mockResolvedValue(undefined) } },
    ],
  }).compile();
  return { service: moduleRef.get(WaitlistService), sendEmail };
}

describe("WaitlistService", () => {
  it("stores the signup and reports its queue position", async () => {
    const { db, values } = makeDb({ id: 42, position: 42 });
    const { service } = await build(db);

    const result = await service.join(input, { clientIp: "1.2.3.4", userAgent: "jest" });

    expect(result).toMatchObject({ ok: true, position: 42, alreadyJoined: false });
    expect(result.reference).toMatch(/^WL-[0-9A-F]{8}$/);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "rohan@example.com",
        organization: "Mehta Solutions",
        ipAddress: "1.2.3.4",
        userAgent: "jest",
      }),
    );
  });

  it("notifies the configured recipients and confirms to the signup", async () => {
    const { db } = makeDb({ id: 7, position: 7 });
    const { service, sendEmail } = await build(db, {
      WAITLIST_NOTIFICATION_EMAILS: "a@example.com, b@example.com",
    });

    await service.join(input, {});

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({
      to: ["a@example.com", "b@example.com"],
      replyTo: "rohan@example.com",
    });
    expect(sendEmail.mock.calls[1]?.[0]).toMatchObject({ to: "rohan@example.com" });
  });

  it("falls back to the founder addresses when nothing is configured", async () => {
    const { db } = makeDb({ id: 1, position: 1 });
    const { service, sendEmail } = await build(db);

    await service.join(input, {});

    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({
      to: ["tarunchintakunta@gmail.com", "adityachalla01@gmail.com"],
    });
  });

  it("treats a repeat submission as the same request and keeps the original reference", async () => {
    const { db } = makeDb({ id: 3, position: 3, existingCode: "WL-ORIGINAL" });
    const { service } = await build(db);

    const result = await service.join(input, {});

    expect(result.alreadyJoined).toBe(true);
    expect(result.reference).toBe("WL-ORIGINAL");
  });

  it("keeps the signup when the notification provider is down", async () => {
    const { db } = makeDb({ id: 9, position: 9 });
    const sendEmail = jest.fn().mockRejectedValue(new Error("provider down"));
    const { service } = await build(db, {}, sendEmail);

    await expect(service.join(input, {})).resolves.toMatchObject({ ok: true, position: 9 });
  });

  it("refuses a submission the bot check rejects", async () => {
    const { db } = makeDb({ id: 1, position: 1 });
    const moduleRef = await Test.createTestingModule({
      providers: [
        WaitlistService,
        { provide: DRIZZLE, useValue: db },
        { provide: APP_CONFIG, useValue: {} },
        { provide: EmailService, useValue: { sendEmail: jest.fn() } },
        {
          provide: TurnstileService,
          useValue: { verify: jest.fn().mockRejectedValue(new Error("Bot verification failed")) },
        },
      ],
    }).compile();

    await expect(moduleRef.get(WaitlistService).join(input, {})).rejects.toThrow(
      "Bot verification failed",
    );
    expect(db.insert).not.toHaveBeenCalled();
  });
});
