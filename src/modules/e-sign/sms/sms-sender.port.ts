/**
 * Sending an SMS, as SignOS needs it.
 *
 * SignOS offers `otp_sms` as a recipient authentication method, requires a
 * phone number when you choose it, and then refuses to sign the envelope —
 * `requestOtp` accepts `otp_email` and nothing else. The method was a menu
 * entry with no implementation behind it.
 *
 * This is the seam an implementation plugs into. It is deliberately two
 * methods rather than one: `isConfigured()` lets the product refuse the option
 * up front, at the point somebody would choose it, instead of accepting the
 * configuration and failing at signing time in front of a customer.
 */
export interface SmsSenderPort {
  /**
   * Whether this environment can actually send. False is a normal answer, not
   * an error state — most deployments have no SMS provider.
   */
  isConfigured(): boolean;

  /** Throws if it cannot deliver. Callers must not treat a throw as "probably fine". */
  send(to: string, body: string): Promise<void>;
}

export const SMS_SENDER = Symbol("SmsSenderPort");
