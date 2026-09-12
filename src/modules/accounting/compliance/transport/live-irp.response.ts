import { z } from "zod";
import type { TransportResult } from "./compliance-transport.port";

/**
 * What this product is willing to believe the Invoice Registration Portal said —
 * the incoming half of the wire contract, and no I/O.
 *
 * This is where `accepted` is decided, which makes it the file the honesty rules
 * are really about: `accepted` is the one state the product renders as *filed*.
 * It is pure so that the rule can be read, and tested, without a socket in the
 * way.
 */

/**
 * The IRP timestamps its acknowledgements in Indian Standard Time and writes no
 * offset. `new Date("2026-09-01 14:20:00")` therefore reads as whatever the host
 * is set to, which silently moves an acknowledgement by hours — and by a day for
 * one issued near midnight. The offset is applied explicitly so a stored
 * `ack_at` means the same instant on every machine.
 */
const IRP_TIMEZONE_OFFSET = "+05:30";

/** NIC's code for "this document already has an IRN", carried in `InfoDtls`. */
const DUPLICATE_REGISTRATION = "DUPIRN";

/** `AckNo` arrives as a number from NIC and as a string from most GSPs. */
const ackNumber = z.union([z.string(), z.number()]).transform((value) => String(value).trim());

const irpAcknowledgement = z.object({
  Irn: z.string().trim().min(1).optional(),
  AckNo: ackNumber.optional(),
  AckDt: z.string().optional(),
});

/**
 * The response envelope, read for the three things that change what is recorded:
 * an IRN, an error list, a duplicate-registration notice.
 *
 * `Status` is deliberately not consulted. It is `"1"` from NIC, `1` from some
 * GSPs and absent from others, and every one of them still says what happened by
 * whether an IRN or an error list came back. Branching on the reliable evidence
 * rather than the unreliable flag is the difference between an adapter that
 * works against a second GSP and one that needs a rewrite.
 *
 * The portal also returns a signed QR code, and it is dropped here on purpose.
 * `TransportResult` has nowhere to put it — its home is
 * `gl_document_compliance.qr_r2_key`, an object-store write this ticket does not
 * make — and stuffing it into a field that means something else would be worse
 * than losing it.
 */
const irpResponseSchema = z.object({
  Data: irpAcknowledgement.optional(),
  ErrorDetails: z
    .array(
      z.object({
        ErrorCode: z
          .union([z.string(), z.number()])
          .transform((value) => String(value).trim())
          .optional(),
        ErrorMessage: z.string().optional(),
      }),
    )
    .optional(),
  InfoDtls: z
    .array(z.object({ InfCd: z.string().optional(), Desc: irpAcknowledgement.optional() }))
    .optional(),
});

/**
 * What the IRP's answer means, in the port's three outcomes.
 *
 * The ordering is load-bearing. A duplicate registration arrives as a *failure*
 * — status 0, error 2150 — with the existing acknowledgement tucked into
 * `InfoDtls`, so reading `ErrorDetails` first would report a document that is
 * registered as rejected, and send somebody to correct an invoice the government
 * already holds.
 */
export function interpretIrpResponse(body: unknown): TransportResult {
  const parsed = irpResponseSchema.safeParse(body);
  if (!parsed.success) {
    return {
      outcome: "unavailable",
      reason:
        "The IRP answered in a shape this product cannot read. Nothing about this document has been judged.",
    };
  }

  const duplicate = parsed.data.InfoDtls?.find(
    (info) => info.InfCd?.toUpperCase() === DUPLICATE_REGISTRATION,
  );
  if (duplicate) {
    /*
      Not a second IRN — the same one. The IRP derives an IRN from the seller's
      GSTIN, the document number and the financial year, so a resubmission of the
      same document can only ever return the registration it already made. That
      is the outermost of this feature's three idempotency fences, and the one
      that still holds when the other two have been bypassed.
    */
    return acknowledgement(
      duplicate.Desc,
      "The IRP says this document is already registered but did not repeat its IRN. " +
        "The document is filed; retrieve the IRN from the portal.",
    );
  }

  if (parsed.data.Data?.Irn) return acknowledgement(parsed.data.Data, "");

  const errors = (parsed.data.ErrorDetails ?? []).map((error) => ({
    /*
      A rejection with no code is still a rejection. The alternative — dropping
      it and falling through to `unavailable` — would leave the row `pending`,
      which says the authority never saw the document.
    */
    code: error.ErrorCode ?? "UNKNOWN",
    message: error.ErrorMessage ?? "The IRP refused this document and gave no reason.",
  }));

  if (errors.length > 0) return { outcome: "rejected", errors };

  return {
    outcome: "unavailable",
    reason:
      "The IRP answered with neither an IRN nor an error. Nothing about this document has been judged.",
  };
}

/**
 * An IRP acknowledgement timestamp, as an instant.
 *
 * Both forms are accepted because both are in the wild — NIC's own responses use
 * `2026-09-01 14:20:00`, and several GSPs re-serialise it as `01/09/2026
 * 14:20:00`. Anything else returns null, and the caller treats an unreadable
 * timestamp as a response it cannot act on rather than substituting its own
 * clock.
 */
export function parseIrpTimestamp(value: string): Date | null {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);

  const fields = iso
    ? { year: iso[1], month: iso[2], day: iso[3], time: `${iso[4]}:${iso[5]}:${iso[6]}` }
    : dmy
      ? { year: dmy[3], month: dmy[2], day: dmy[1], time: `${dmy[4]}:${dmy[5]}:${dmy[6]}` }
      : null;
  if (!fields) return null;

  const parsed = new Date(
    `${fields.year}-${fields.month}-${fields.day}T${fields.time}${IRP_TIMEZONE_OFFSET}`,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * An acknowledgement, or an honest refusal to call one an acknowledgement.
 *
 * All three fields or none. `accepted` is the one outcome the product renders as
 * *filed*, and it renders it on the strength of the stored identifier — an
 * `accepted` row with a missing IRN or an unreadable timestamp is a compliance
 * claim with a hole in its evidence, which `compliance.controller` already
 * refuses to believe. Better to keep the row `pending` and put what the IRP did
 * say into the reason, where a human reads it, than to write two thirds of an
 * acknowledgement and let it read as a filing.
 */
function acknowledgement(
  ack: { Irn?: string; AckNo?: string; AckDt?: string } | undefined,
  fallbackReason: string,
): TransportResult {
  const ackAt = ack?.AckDt ? parseIrpTimestamp(ack.AckDt) : null;

  if (ack?.Irn && ack.AckNo && ackAt) {
    return { outcome: "accepted", authorityId: ack.Irn, ackNo: ack.AckNo, ackAt };
  }

  if (ack?.Irn) {
    return {
      outcome: "unavailable",
      reason:
        `The IRP returned IRN ${ack.Irn} without a readable acknowledgement number and date. ` +
        "The document appears to be registered; confirm it on the portal before filing it again.",
    };
  }

  return {
    outcome: "unavailable",
    reason:
      fallbackReason ||
      "The IRP answered without an IRN. Nothing about this document has been judged.",
  };
}
