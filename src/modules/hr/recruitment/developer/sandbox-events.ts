import { createHmac, timingSafeEqual } from "node:crypto";
import {
  HR_AUTOMATION_EVENTS,
  HR_EVENT_FIELD_DOCS,
  HR_EVENT_SAMPLE_PAYLOADS,
  type EventFieldDoc,
  type HrAutomationEvent,
} from "../../automations/hr-automation-events";
import {
  RECRUITMENT_EVENTS,
  RECRUITMENT_EVENT_FIELD_DOCS,
  RECRUITMENT_EVENT_SAMPLE_PAYLOADS,
  type RecruitmentEvent,
} from "../recruitment-webhook-events";

/**
 * Every event a tenant's webhook can carry, in one list.
 *
 * `hr_webhook_subscriptions` and `hr_webhook_deliveries` are written by two
 * services — `HrWebhooksService` for the automation events and
 * `RecruitmentWebhooksService` for the hiring ones — and only the first
 * one's vocabulary was ever consulted when reading a row back. So a
 * subscription to `candidate.hired` tested as `employee.created`, a recruitment
 * delivery could not be redelivered at all ("unknown automation event"), and
 * `retryPending` skipped every failed recruitment delivery in the table. Three
 * bugs from one missing union, and each of them looks like a different feature
 * being broken.
 */
export const SANDBOX_EVENTS = [...HR_AUTOMATION_EVENTS, ...RECRUITMENT_EVENTS] as const;

export type SandboxEvent = HrAutomationEvent | RecruitmentEvent;

export function isSandboxEvent(value: string): value is SandboxEvent {
  return (SANDBOX_EVENTS as readonly string[]).includes(value);
}

export function isRecruitmentEvent(value: string): value is RecruitmentEvent {
  return (RECRUITMENT_EVENTS as readonly string[]).includes(value);
}

/**
 * The example body a developer can build against.
 *
 * Returns `{}` for an event with no recorded sample rather than throwing: a
 * missing sample is a gap in the docs, and a 500 on the docs page is a worse
 * answer to it than an empty object the reader can see is empty.
 */
export function samplePayloadFor(event: SandboxEvent): Record<string, unknown> {
  if (isRecruitmentEvent(event)) return RECRUITMENT_EVENT_SAMPLE_PAYLOADS[event] ?? {};
  return HR_EVENT_SAMPLE_PAYLOADS[event] ?? {};
}

/**
 * One field-doc shape across both vocabularies.
 *
 * The HR map carries a declared type per field and the recruitment map carries
 * only a sentence, so `type` is optional here and is left off rather than
 * guessed. Defaulting the recruitment fields to `"string"` would publish a
 * contract saying `candidateId` is a string, which it is not.
 */
export interface SandboxFieldDoc {
  field: string;
  label: string;
  type?: EventFieldDoc["type"];
}

export function fieldDocsFor(event: SandboxEvent): SandboxFieldDoc[] {
  if (isRecruitmentEvent(event)) {
    return Object.entries(RECRUITMENT_EVENT_FIELD_DOCS[event] ?? {}).map(([field, label]) => ({
      field,
      label,
    }));
  }
  return HR_EVENT_FIELD_DOCS[event] ?? [];
}

/**
 * The exact bytes a receiver is sent, built in one place.
 *
 * Both dispatchers `JSON.stringify` an object of this shape independently. A
 * developer verifying an HMAC has to reproduce the body byte for byte, so the
 * shape is a contract and not an implementation detail — which is the argument
 * for it having a name.
 */
export function sandboxBody(event: SandboxEvent, payload: Record<string, unknown>, at: Date): string {
  return JSON.stringify({ event, data: payload, timestamp: at.toISOString() });
}

export function sandboxSignature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * The check a receiver should perform, published so that the documentation and
 * the sandbox cannot describe a different algorithm from the one that signs.
 *
 * Length first, because `timingSafeEqual` throws on a length mismatch rather
 * than returning false — a caller who skips that turns a malformed header into
 * a 500.
 */
export function verifySandboxSignature(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(sandboxSignature(secret, body));
  const received = Buffer.from(signature);
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
