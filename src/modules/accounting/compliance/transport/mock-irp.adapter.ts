import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { ComplianceTransport } from "../../../../db/schema";
import type {
  CompliancePayload,
  ComplianceTransportAdapter,
  TransportResult,
} from "./compliance-transport.port";

/**
 * An IRP that is not an IRP, and says so in every artefact it leaves behind.
 *
 * This exists so the submit path can be built, tested and reviewed before
 * anyone has GST portal credentials — ACC-13 before ACC-14. The danger of such
 * a thing is obvious and is the reason for most of the decisions below: a mock
 * that produces convincing output is worse than no mock at all, because the
 * moment its output escapes into a report, a screenshot or a support
 * conversation it becomes a claim that a statutory filing happened.
 *
 * So it is built to be impossible to mistake:
 *
 *  - it writes `transport = 'mock_irp'`, its own enum member (0673), so the row
 *    carries its provenance even after a database restore into another
 *    deployment;
 *  - its acknowledgement is prefixed `MOCK-`, and a real IRN never is;
 *  - `isReal` is `false`, which the API surfaces so a screen can refuse to
 *    render it as a filing;
 *  - it refuses to run in production at all.
 *
 * What it does NOT do is randomise. A mock that fails one call in ten produces
 * flaky tests and teaches everyone to retry; this one is a pure function of the
 * payload, so the same document always gets the same answer and a rejection can
 * be reproduced on demand.
 */
@Injectable()
export class MockIrpAdapter implements ComplianceTransportAdapter {
  readonly transport: ComplianceTransport = "mock_irp";
  readonly name = "Mock IRP (no document is filed)";
  readonly isReal = false;

  async submit(payload: CompliancePayload): Promise<TransportResult> {
    /*
      The real IRP refuses a B2B invoice with no buyer GSTIN, and it is the
      commonest rejection there is. Reproducing it is the point of having a
      mock: the rejection path gets exercised by every test that forgets a
      buyer, rather than only by the one test written for it.
    */
    if (!payload.buyerTaxId) {
      return {
        outcome: "rejected",
        errors: [
          {
            code: "MOCK_2150",
            message:
              "A reportable B2B document needs the buyer's tax identifier. " +
              "(Refused by the mock transport; nothing was sent anywhere.)",
          },
        ],
      };
    }

    if (payload.totalMinor <= 0) {
      return {
        outcome: "rejected",
        errors: [
          {
            code: "MOCK_2172",
            message:
              "A document with no positive value is not reportable. " +
              "(Refused by the mock transport; nothing was sent anywhere.)",
          },
        ],
      };
    }

    /*
      Deterministic from the document's own identity, so a redelivery of the
      same document produces the same acknowledgement — which is what a real
      IRP does, and what makes the idempotent recording path testable.
    */
    const digest = createHash("sha256")
      .update(`${payload.documentType}:${payload.documentId}:${payload.documentNumber}`)
      .digest("hex")
      .slice(0, 24)
      .toUpperCase();

    return {
      outcome: "accepted",
      // `MOCK-` first, and never removable without failing this pack's ratchet.
      authorityId: `MOCK-IRN-${digest}`,
      ackNo: `MOCK-ACK-${digest.slice(0, 10)}`,
      /*
        The payload's own date, not `new Date()`. An acknowledgement timestamp
        that moved every run would make a recorded mock filing look freshly
        obtained each time somebody re-read it.
      */
      ackAt: new Date(`${payload.documentDate}T00:00:00.000Z`),
    };
  }
}
