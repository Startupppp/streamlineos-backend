import { Test } from "@nestjs/testing";
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
function makeDb(row: { id: number; existingCode?: string }) {
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
  return { db: { insert }, insert, values, onConflictDoUpdate, returning };
}

async function build(
  db: unknown,
  sendEmail = jest.fn().mockResolvedValue(undefined),
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      WaitlistService,
      { provide: DRIZZLE, useValue: db },
      { provide: EmailService, useValue: { sendEmail } },
      { provide: TurnstileService, useValue: { verify: jest.fn().mockResolvedValue(undefined) } },
    ],
  }).compile();
  return { service: moduleRef.get(WaitlistService), sendEmail };
}

describe("WaitlistService", () => {
  it("stores the signup and returns its reference", async () => {
    const { db, values } = makeDb({ id: 42 });
    const { service } = await build(db);

    const result = await service.join(input, { clientIp: "1.2.3.4", userAgent: "jest" });

    expect(result).toMatchObject({ ok: true, alreadyJoined: false });
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

  it("notifies both founders and confirms to the signup", async () => {
    const { db } = makeDb({ id: 7 });
    const { service, sendEmail } = await build(db);

    await service.join(input, {});

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({
      to: ["tarunchintakunta@gmail.com", "adityachalla01@gmail.com"],
      replyTo: "rohan@example.com",
    });
    expect(sendEmail.mock.calls[1]?.[0]).toMatchObject({ to: "rohan@example.com" });
  });

  it("takes the recipients from code, not the environment", async () => {
    process.env.WAITLIST_NOTIFICATION_EMAILS = "hijack@example.com";
    const { db } = makeDb({ id: 1 });
    const { service, sendEmail } = await build(db);

    await service.join(input, {});
    delete process.env.WAITLIST_NOTIFICATION_EMAILS;

    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({
      to: ["tarunchintakunta@gmail.com", "adityachalla01@gmail.com"],
    });
  });

  it("treats a repeat submission as the same request and keeps the original reference", async () => {
    const { db } = makeDb({ id: 3, existingCode: "WL-ORIGINAL" });
    const { service } = await build(db);

    const result = await service.join(input, {});

    expect(result.alreadyJoined).toBe(true);
    expect(result.reference).toBe("WL-ORIGINAL");
  });

  it("keeps the signup when the notification provider is down", async () => {
    const { db } = makeDb({ id: 9 });
    const sendEmail = jest.fn().mockRejectedValue(new Error("provider down"));
    const { service } = await build(db, sendEmail);

    await expect(service.join(input, {})).resolves.toMatchObject({ ok: true });
  });

  it("refuses a submission the bot check rejects", async () => {
    const { db } = makeDb({ id: 1 });
    const moduleRef = await Test.createTestingModule({
      providers: [
        WaitlistService,
        { provide: DRIZZLE, useValue: db },
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
