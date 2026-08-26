import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
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
 * Where a signup announces itself when nothing is configured. The addresses are
 * the founders' own, so the list is never silently accumulating unread rows —
 * `WAITLIST_NOTIFICATION_EMAILS` overrides them per deployment.
 */
const DEFAULT_NOTIFICATION_EMAILS = [
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
    @Inject(APP_CONFIG) private readonly config: AppConfig,
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

  private getNotificationEmails(): string[] {
    const configured = this.config.WAITLIST_NOTIFICATION_EMAILS?.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return configured?.length ? configured : DEFAULT_NOTIFICATION_EMAILS;
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
        to: this.getNotificationEmails(),
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
