/**
 * Transports that produce an acknowledgement and file nothing.
 *
 * Membership here is the difference between a test fixture and a fabricated
 * statutory record, so it is a list rather than a naming convention.
 */
export const SYNTHETIC_TRANSPORTS = new Set(["mock_irp"]);

/**
 * One line for a document that may carry several compliance rows.
 *
 * A real filing wins, then an outstanding obligation, then whatever is left.
 * The order matters: a document with a `mock_irp` submission and an `irp`
 * obligation must lead with the obligation, because the mock filed nothing and
 * the duty is still outstanding.
 */
export function overallHeadline(states: Array<Parameters<typeof describe>[0]>): string {
  const narratives = states.map((state) => ({ state, narrative: describe(state) }));
  const filed = narratives.find((n) => n.narrative.filed);
  if (filed) return filed.narrative.headline;

  const outstanding = narratives.find((n) => n.state.status === "pending");
  if (outstanding) return outstanding.narrative.headline;

  return narratives[0]?.narrative.headline ?? "No reporting state is recorded.";
}

export interface ComplianceNarrative {
  /** One line, in the words the person raising the invoice would use. */
  headline: string;
  /** True only when an authority has actually acknowledged the document. */
  filed: boolean;
  /** What the person has to do, if anything. */
  action: string | null;
}

/**
 * Turn the stored state into something that cannot be misread.
 *
 * `pending` is the word that does the damage. In every other system it means
 * "in flight, wait" — here it means "we decided this is reportable and there is
 * no connection to report it over, so nobody is going to send it". Rendering
 * the raw enum would let a UI show a spinner for a request that will never be
 * made, which is a more convincing lie than a wrong label.
 */
export function describe(state: {
  transport: string;
  status: string;
  authorityId: string | null;
  ackNo: string | null;
}): ComplianceNarrative {
  const acknowledged = Boolean(state.authorityId ?? state.ackNo);

  /*
    A synthetic transport can reach `accepted` with an acknowledgement in hand
    and has still filed nothing — that is the entire risk of shipping ACC-13's
    mock before ACC-14's provider. Checked before the switch rather than inside
    the `accepted` branch, so a future synthetic transport cannot be added and
    quietly inherit the flattering answer from a branch nobody re-read.
  */
  if (SYNTHETIC_TRANSPORTS.has(state.transport)) {
    return {
      headline:
        "Handled by a mock e-invoice transport. Nothing was sent to any authority and this " +
        "document is not filed.",
      filed: false,
      action: "File it directly with the authority, outside this product.",
    };
  }

  switch (state.status) {
    case "not_required":
      return {
        headline: "No e-invoice reporting is required for this document.",
        filed: false,
        action: null,
      };

    case "pending":
      return {
        headline:
          `This document is reportable to the ${state.transport.toUpperCase()} and has not been ` +
          "sent. This product has no connection to that authority, so it will not be sent " +
          "automatically.",
        filed: false,
        action: "File it directly with the authority, outside this product.",
      };

    case "submitted":
      /*
        Reachable only once a transport exists. Submitted is NOT filed: the
        authority has the document and has not acknowledged it, and an invoice
        that was rejected passed through this state on the way.
      */
      return {
        headline: `Sent to the ${state.transport.toUpperCase()} and not yet acknowledged.`,
        filed: false,
        action: null,
      };

    case "accepted":
      /*
        The only state that may say filed, and only with an identifier from the
        authority in hand. An `accepted` row with no `authorityId` is a bug
        somewhere upstream, and this reports it as one rather than believing it.
      */
      return acknowledged
        ? {
            headline: `Accepted by the ${state.transport.toUpperCase()}.`,
            filed: true,
            action: null,
          }
        : {
            headline:
              "Recorded as accepted, but no acknowledgement number was stored. Treat this " +
              "document as unfiled until that is resolved.",
            filed: false,
            action: "Check with the authority whether this document was actually received.",
          };

    case "rejected":
      return {
        headline: `Rejected by the ${state.transport.toUpperCase()}.`,
        filed: false,
        action: "Correct the document and file it again.",
      };

    case "cancelled":
      return {
        headline: `Cancelled with the ${state.transport.toUpperCase()}.`,
        filed: false,
        action: null,
      };

    default:
      /*
        An unknown status must never read as filed. A new enum member added
        without a branch here defaults to the honest answer rather than the
        flattering one.
      */
      return {
        headline: `Reporting state "${state.status}" is not one this product can explain.`,
        filed: false,
        action: null,
      };
  }
}
