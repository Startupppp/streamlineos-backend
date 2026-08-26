import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { platformWaitlist } from "../../db/schema";
import { logger } from "../../common/logger/logger.service";
import { TurnstileService } from "../../common/security/turnstile.service";
import { EmailService } from "../email/email.service";
import {
  getWaitlistAdminNotificationEmail,
  getWaitlistConfirmationEmail,
} from "../email/templates";
import type { WaitlistJoinInput } from "./dto/public.schemas";

/**
 * Where every waitlist signup announces itself. Deliberately hardcoded rather
 * than read from the environment, so the notification cannot silently go
 * nowhere because a deployment forgot to set a variable — the cost is that
 * changing a recipient is a code change and a deploy.
 */
const NOTIFICATION_EMAILS = [
  "tarunchintakunta@gmail.com",
  "adityachalla01@gmail.com",
];

export interface WaitlistJoinResult {
  ok: true;
  reference: string;
  alreadyJoined: boolean;
}

@Injectable()
export class WaitlistService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
    private readonly turnstile: TurnstileService,
  ) {}

  async join(
    input: WaitlistJoinInput,
    context: { clientIp?: string; userAgent?: string; referrer?: string },
  ): Promise<WaitlistJoinResult> {
    await this.turnstile.verify(input.cfTurnstileToken, context.clientIp);

    const reference = `WL-${randomBytes(4).toString("hex").toUpperCase()}`;

    /*
     * A second submission from the same address is the same request restated,
     * not a conflict the visitor can act on — so the later answers win and the
     * original reference is kept.
     */
    const [row] = await this.db
      .insert(platformWaitlist)
      .values({
        publicCode: reference,
        name: input.name,
        email: input.email,
        organization: input.organization ?? null,
        role: input.role ?? null,
        teamSize: input.teamSize ?? null,
        notes: input.notes ?? null,
        ipAddress: context.clientIp ?? null,
        userAgent: context.userAgent ?? null,
        referrerUrl: context.referrer ?? null,
      })
      .onConflictDoUpdate({
        target: platformWaitlist.email,
        set: {
          name: input.name,
          organization: input.organization ?? null,
          role: input.role ?? null,
          teamSize: input.teamSize ?? null,
          notes: input.notes ?? null,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: platformWaitlist.id,
        publicCode: platformWaitlist.publicCode,
        createdAt: platformWaitlist.createdAt,
      });

    if (!row) throw new Error("Waitlist row was not returned by the insert");

    const alreadyJoined = row.publicCode !== reference;
    const receivedAt = new Date().toISOString();

    await this.notify({
      input,
      reference: row.publicCode,
      receivedAt,
      alreadyJoined,
    });

    return {
      ok: true,
      reference: row.publicCode,
      alreadyJoined,
    };
  }

  /*
   * Best-effort on purpose. The row is already durable, so a provider outage
   * must not turn a captured signup into a 500 that tells the visitor to try
   * again — but it is logged rather than swallowed (backend CLAUDE.md §4).
   */
  private async notify(params: {
    input: WaitlistJoinInput;
    reference: string;
    receivedAt: string;
    alreadyJoined: boolean;
  }): Promise<void> {
    const { input, reference, receivedAt, alreadyJoined } = params;

    try {
      const admin = getWaitlistAdminNotificationEmail({
        name: input.name,
        email: input.email,
        reference,
        receivedAt,
        organization: input.organization,
        role: input.role,
        teamSize: input.teamSize,
        notes: input.notes,
        returning: alreadyJoined,
      });
      await this.email.sendEmail({
        to: NOTIFICATION_EMAILS,
        replyTo: input.email,
        subject: admin.subject,
        html: admin.html,
      });
    } catch (error) {
      logger.error("[waitlist] Admin notification failed", { error, reference });
    }

    try {
      const confirmation = getWaitlistConfirmationEmail({
        name: input.name,
        reference,
      });
      await this.email.sendEmail({
        to: input.email,
        subject: confirmation.subject,
        html: confirmation.html,
      });
    } catch (error) {
      logger.error("[waitlist] Confirmation email failed", { error, reference });
    }
  }
}
