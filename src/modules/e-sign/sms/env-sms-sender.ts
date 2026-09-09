import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { SmsSenderPort } from "./sms-sender.port";

/**
 * The sender that ships: it reports honestly that nothing is configured.
 *
 * No SMS provider credentials exist in this codebase and this pack does not add
 * one. Rather than pretend — a no-op `send` that resolves would make every OTP
 * "sent" and every signer stuck waiting for a code that was never dispatched —
 * this answers `isConfigured(): false` so callers refuse the option, and throws
 * if anybody sends anyway.
 *
 * Binding a real provider means replacing this class. Nothing else in SignOS
 * changes; `sign-public.service` already implements the full otp_sms flow
 * against this interface, and the tests exercise it with a stub sender.
 */
@Injectable()
export class EnvSmsSender implements SmsSenderPort {
  private readonly logger = new Logger(EnvSmsSender.name);

  /**
   * Read once, at construction, so that "is SMS available" cannot change
   * between the check at envelope-configuration time and the send at signing
   * time. A recipient configured for SMS on Monday must not become unsignable
   * because an environment variable moved on Tuesday.
   */
  private readonly configured =
    Boolean(process.env.SIGN_SMS_PROVIDER_URL) && Boolean(process.env.SIGN_SMS_PROVIDER_TOKEN);

  isConfigured(): boolean {
    return this.configured;
  }

  async send(to: string, _body: string): Promise<void> {
    if (!this.configured) {
      this.logger.warn(
        `refusing to send an SMS one-time code to ${to.slice(0, 4)}…: no SMS provider is ` +
          `configured (SIGN_SMS_PROVIDER_URL / SIGN_SMS_PROVIDER_TOKEN)`,
      );
      throw new ServiceUnavailableException(
        "SMS delivery is not configured in this environment",
      );
    }

    /**
     * Deliberately unimplemented rather than guessed. Writing an HTTP call
     * against an imagined provider shape would look like working code, ship
     * green, and fail the first time real credentials appeared. The interface
     * is the deliverable; the provider is a decision with a contract and a
     * bill attached.
     */
    throw new ServiceUnavailableException(
      "SMS provider credentials are present but no provider implementation is bound",
    );
  }
}
