import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { SignSettingsService } from "./sign-settings.service";
import { SMS_SENDER, type SmsSenderPort } from "./sms/sms-sender.port";
import type { CreateRecipientInput } from "./dto/e-sign.schemas";

export type SignAuthMethod = NonNullable<CreateRecipientInput["authMethod"]>;

/**
 * The one place that decides whether a recipient may be configured for an
 * authentication method.
 *
 * It began as a private method on `SignRecipientsService`, guarding `add`. Two
 * other paths reach the same column and neither went through it: `update`,
 * which takes the same eight-value enum via `createRecipientSchema.partial()`,
 * and template instantiation, which replays whatever `authMethod` the snapshot
 * carries. The second is not a legacy-row problem — `createTemplateSchema`
 * declares `templateJson` as `z.record(z.string(), z.unknown())`, so a caller
 * holding `sign:template:manage` can post a role with any method at all and
 * then instantiate envelopes from it.
 *
 * A shared object rather than a copied check, because the interesting failure
 * is not one path being wrong today but the two drifting: the moment SMS
 * availability is consulted in one and not the other, the refusal an operator
 * gets depends on which door they came through.
 */
@Injectable()
export class SignAuthMethodPolicy {
  constructor(
    private readonly settings: SignSettingsService,
    @Inject(SMS_SENDER) private readonly sms: SmsSenderPort,
  ) {}

  /**
   * `subject` names what is being configured, so a refusal from a template
   * points at the role rather than reading as though a recipient was rejected.
   */
  async assertUsable(
    orgId: string,
    method: SignAuthMethod | undefined,
    phone: string | null | undefined,
    subject = "recipient",
  ): Promise<void> {
    if (!method || method === "email_link") return;

    const settings = await this.settings.getOrCreate(orgId);
    const allowed = settings.allowedAuthMethods ?? [];
    if (!allowed.includes(method)) {
      throw new BadRequestException(
        `Authentication method "${method}" is not enabled for this organisation (${subject}). ` +
          `Enabled methods: ${allowed.join(", ") || "none"}.`,
      );
    }

    /**
     * Enabled is not the same as available. An organisation may have added
     * `otp_sms` to its list, but if this deployment has no SMS provider the
     * code can never be delivered — so the phone number is not requested
     * either, because requiring a field for a channel that cannot send is the
     * broken promise this exists to prevent.
     */
    if (method === "otp_sms") {
      if (!this.sms.isConfigured()) {
        throw new BadRequestException(
          "SMS one-time codes are enabled for this organisation but no SMS provider is " +
            `configured in this environment, so the code could not be delivered (${subject}).`,
        );
      }
      if (!phone) {
        throw new BadRequestException(
          `Phone number is required when SMS OTP authentication is selected (${subject})`,
        );
      }
    }
  }
}
