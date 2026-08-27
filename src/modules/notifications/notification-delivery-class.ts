export const DeliveryClass = {
  PRODUCT_EVENT: "PRODUCT_EVENT",
  USER_AUTHORED: "USER_AUTHORED",
  WORKFLOW_EXTERNAL: "WORKFLOW_EXTERNAL",
  OPERATOR_ALERT: "OPERATOR_ALERT",
  MARKETING: "MARKETING",
} as const;

export type DeliveryClass = (typeof DeliveryClass)[keyof typeof DeliveryClass];

export type AuthorizationRule =
  | "authenticated-member"
  | "system-automation"
  | "platform-operator"
  | "public-unauthenticated"
  | "verified-consent";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMinutes: readonly number[];
  readonly retryable: boolean;
  readonly deadLetterAfterMs: number;
}

export interface DeliveryClassPolicy {
  readonly deliveryClass: DeliveryClass;
  readonly authorizationRule: AuthorizationRule;
  readonly auditRequired: boolean;
  readonly retryPolicy: RetryPolicy;
  readonly requiresConsent: boolean;
  readonly requiresUnsubscribeLink: boolean;
}

export const DELIVERY_CLASS_POLICIES: Readonly<Record<DeliveryClass, DeliveryClassPolicy>> = {
  PRODUCT_EVENT: {
    deliveryClass: "PRODUCT_EVENT",
    authorizationRule: "authenticated-member",
    auditRequired: true,
    retryPolicy: {
      maxAttempts: 5,
      backoffMinutes: [1, 5, 15, 60, 360],
      retryable: true,
      deadLetterAfterMs: 24 * 60 * 60 * 1000,
    },
    requiresConsent: false,
    requiresUnsubscribeLink: false,
  },

  USER_AUTHORED: {
    deliveryClass: "USER_AUTHORED",
    authorizationRule: "authenticated-member",
    auditRequired: true,
    retryPolicy: {
      maxAttempts: 3,
      backoffMinutes: [1, 5, 15],
      retryable: true,
      deadLetterAfterMs: 4 * 60 * 60 * 1000,
    },
    requiresConsent: false,
    requiresUnsubscribeLink: false,
  },

  WORKFLOW_EXTERNAL: {
    deliveryClass: "WORKFLOW_EXTERNAL",
    authorizationRule: "system-automation",
    auditRequired: true,
    retryPolicy: {
      maxAttempts: 3,
      backoffMinutes: [1, 5, 30],
      retryable: true,
      deadLetterAfterMs: 4 * 60 * 60 * 1000,
    },
    requiresConsent: false,
    requiresUnsubscribeLink: false,
  },

  OPERATOR_ALERT: {
    deliveryClass: "OPERATOR_ALERT",
    authorizationRule: "platform-operator",
    auditRequired: true,
    retryPolicy: {
      maxAttempts: 10,
      backoffMinutes: [1, 2, 5, 10, 15, 15, 15, 30, 30, 60],
      retryable: true,
      deadLetterAfterMs: 30 * 60 * 1000,
    },
    requiresConsent: false,
    requiresUnsubscribeLink: false,
  },

  MARKETING: {
    deliveryClass: "MARKETING",
    authorizationRule: "verified-consent",
    auditRequired: true,
    retryPolicy: {
      maxAttempts: 2,
      backoffMinutes: [5, 60],
      retryable: false,
      deadLetterAfterMs: 2 * 60 * 60 * 1000,
    },
    requiresConsent: true,
    requiresUnsubscribeLink: true,
  },
} as const;

/**
 * The backoff step for a given attempt, clamped at the last step.
 *
 * This exists so the delivery worker stops carrying its own `BACKOFF_MINUTES` constant. Two copies
 * of a retry curve is one copy too many: the registry claimed to own retry rules while the only
 * code that retried anything read a private array, so changing the registry changed nothing.
 *
 * Attempts are 1-based, matching `notification_deliveries.attempt_count + 1` at the call site.
 */
export function backoffMinutesForAttempt(deliveryClass: DeliveryClass, attempt: number): number {
  const steps = DELIVERY_CLASS_POLICIES[deliveryClass].retryPolicy.backoffMinutes;
  const last = steps[steps.length - 1] ?? 60;
  if (attempt <= 1) return steps[0] ?? last;
  return steps[Math.min(attempt - 1, steps.length - 1)] ?? last;
}

/**
 * Every event in the catalog is a product event by construction — the catalog *is* the
 * product-event pipeline. The other four classes describe senders that never enter it, which is
 * why they appear in `notification-caller-inventory.ts` rather than here.
 *
 * An unknown or absent key resolves to PRODUCT_EVENT rather than throwing: a delivery already
 * committed must not become unretryable because its event was renamed.
 */
export function resolveDeliveryClassForEvent(eventKey: string | undefined): DeliveryClass {
  if (!eventKey) return DeliveryClass.PRODUCT_EVENT;
  return DeliveryClass.PRODUCT_EVENT;
}

export type MarketingConsentProof = { readonly consentVerified: true };

export function createMarketingConsentProof(): MarketingConsentProof {
  return { consentVerified: true };
}

export function requireConsentProofForMarketing(
  deliveryClass: DeliveryClass,
  proof: MarketingConsentProof | undefined,
): void {
  const policy = DELIVERY_CLASS_POLICIES[deliveryClass];
  if (!policy.requiresConsent) return;
  if (proof?.consentVerified !== true) {
    throw new Error(
      "MARKETING delivery requires recorded per-recipient consent. " +
        "For CRM contacts: call CrmConsentService.suppressedEmails() first, then pass createMarketingConsentProof(). " +
        "For org members: no consent table exists. Member marketing is not available.",
    );
  }
}
