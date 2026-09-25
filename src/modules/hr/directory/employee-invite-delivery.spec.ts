import { QueryBuilder } from "drizzle-orm/pg-core";
import type { EmailOutboxStatus } from "../../../db/schema/common/email";
import { emailOutbox } from "../../../db/schema";
import {
  INVITE_DELIVERY_STATUSES,
  NO_INVITE_DELIVERY,
  inviteDeliveryStatusOf,
  inviteOutboxWhere,
  toInviteDeliveryState,
} from "./employee-invite-delivery";
import { employeeDetailSchema } from "./dto/directory-response.schemas";

/**
 * HRMS-E2E-018. The acceptance criterion names five delivery states — queued,
 * sent, delivered, bounced, failed — but only the ones the server can actually
 * observe may ever reach the screen. `email_outbox.status` is the whole of what
 * this product knows about an invite, and its five values are PENDING, SENT,
 * FAILED, DEAD and SUPPRESSED. There is no per-message provider receipt: the
 * bounce webhook writes `email_suppressions` keyed on the ADDRESS, platform-wide,
 * with no provider message id to join back to an outbox row. So `delivered` and
 * `bounced` are unknowable per invite, and nothing here may produce them.
 */
const EVERY_OUTBOX_STATUS: readonly EmailOutboxStatus[] = [
  "PENDING",
  "SENT",
  "FAILED",
  "DEAD",
  "SUPPRESSED",
];

describe("invite delivery status is only what the outbox observed", () => {
  it("never reports a state the provider never confirmed", () => {
    expect(INVITE_DELIVERY_STATUSES).not.toContain("delivered");
    expect(INVITE_DELIVERY_STATUSES).not.toContain("bounced");
  });

  it.each(EVERY_OUTBOX_STATUS)(
    "maps the reachable outbox status %s onto a declared state",
    (status) => {
      const mapped = inviteDeliveryStatusOf(status);
      expect(INVITE_DELIVERY_STATUSES).toContain(mapped);
      expect(mapped).not.toBe("delivered");
      expect(mapped).not.toBe("bounced");
    },
  );

  it("distinguishes queued from sent, because the outbox accepting a message is not the provider taking it", () => {
    expect(inviteDeliveryStatusOf("PENDING")).toBe("queued");
    expect(inviteDeliveryStatusOf("SENT")).toBe("sent");
  });

  it("reports both a retryable failure and an exhausted one as failed", () => {
    expect(inviteDeliveryStatusOf("FAILED")).toBe("failed");
    expect(inviteDeliveryStatusOf("DEAD")).toBe("failed");
  });

  it("reports a withheld send as suppressed rather than as sent or failed", () => {
    expect(inviteDeliveryStatusOf("SUPPRESSED")).toBe("suppressed");
  });

  it("says nothing at all when no invite email was ever written", () => {
    expect(toInviteDeliveryState(undefined)).toEqual(NO_INVITE_DELIVERY);
    expect(NO_INVITE_DELIVERY.status).toBe("none");
    expect(NO_INVITE_DELIVERY.sentAt).toBeNull();
  });

  it("carries sentAt only for a row the provider actually accepted", () => {
    const queuedAt = new Date("2026-09-20T10:00:00.000Z");
    const sentAt = new Date("2026-09-20T10:00:04.000Z");

    expect(
      toInviteDeliveryState({
        status: "SENT",
        createdAt: queuedAt,
        sentAt,
        attempts: 1,
        lastError: null,
      }),
    ).toEqual({
      status: "sent",
      queuedAt,
      sentAt,
      attempts: 1,
      lastError: null,
      deliveryConfirmed: false,
    });

    expect(
      toInviteDeliveryState({
        status: "PENDING",
        createdAt: queuedAt,
        sentAt: null,
        attempts: 0,
        lastError: null,
      }).sentAt,
    ).toBeNull();
  });

  it("never claims the message reached an inbox, whatever the outbox says", () => {
    for (const status of EVERY_OUTBOX_STATUS) {
      expect(
        toInviteDeliveryState({
          status,
          createdAt: new Date(),
          sentAt: new Date(),
          attempts: 3,
          lastError: null,
        }).deliveryConfirmed,
      ).toBe(false);
    }
  });

  it("surfaces the provider error on a failed row, so an administrator learns why", () => {
    expect(
      toInviteDeliveryState({
        status: "FAILED",
        createdAt: new Date(),
        sentAt: null,
        attempts: 1,
        lastError: "No email provider configured",
      }).lastError,
    ).toBe("No email provider configured");
  });
});

describe("the invite outbox read is tenant-scoped and invite-specific", () => {
  function renderedWhere(orgId: string, email: string) {
    return new QueryBuilder()
      .select({ status: emailOutbox.status })
      .from(emailOutbox)
      .where(inviteOutboxWhere(orgId, email))
      .toSQL();
  }

  it("binds the organisation and the recipient address, so one tenant cannot read another's invite mail", () => {
    const query = renderedWhere("org-a", "ada@example.test");

    expect(query.sql).toContain('"organization_id"');
    expect(query.sql).toContain('"to_email"');
    expect(query.params).toContain("org-a");
    expect(query.params).toContain("ada@example.test");
  });

  it("matches only invite mail, not every message ever sent to that address", () => {
    const query = renderedWhere("org-a", "ada@example.test");

    expect(query.sql).toContain('"subject"');
    expect(
      query.params.some(
        (param) => typeof param === "string" && param.startsWith("You've been added to"),
      ),
    ).toBe(true);
  });
});

describe("the employee detail contract carries the delivery status", () => {
  it("declares inviteDelivery on the employee detail response", () => {
    const shape = Object.keys(employeeDetailSchema.shape);
    expect(shape).toContain("inviteDelivery");
  });

  it("refuses a delivery state the server cannot observe", () => {
    const field = employeeDetailSchema.shape.inviteDelivery;
    expect(
      field.safeParse({
        status: "delivered",
        queuedAt: null,
        sentAt: null,
        attempts: 0,
        lastError: null,
        deliveryConfirmed: false,
      }).success,
    ).toBe(false);
    expect(
      field.safeParse({
        status: "bounced",
        queuedAt: null,
        sentAt: null,
        attempts: 0,
        lastError: null,
        deliveryConfirmed: false,
      }).success,
    ).toBe(false);
    expect(
      field.safeParse({
        status: "queued",
        queuedAt: new Date(),
        sentAt: null,
        attempts: 0,
        lastError: null,
        deliveryConfirmed: false,
      }).success,
    ).toBe(true);
  });
});
