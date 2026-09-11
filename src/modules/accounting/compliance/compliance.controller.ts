import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import {
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { BooksService } from "../kernel/books.service";
import { ComplianceService } from "./compliance.service";
import { ComplianceTransportRegistry } from "./transport/compliance-transport.registry";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";

/**
 * What the product has and has not done about a document's e-reporting duty.
 *
 * ACC-12 is usually read as "never claim an invoice was filed when it was not",
 * and by that reading this was already safe: `ComplianceService` only ever
 * writes `not_required` or `pending`, and nothing renders it.
 *
 * Nothing rendered it because **nothing could**. `ComplianceService.get` had no
 * caller anywhere — no route, no inclusion in the AR document view. So on an
 * Indian B2B invoice the product decided an IRN was owed, wrote that decision
 * down, sent nothing, and told the person who raised the invoice nothing at
 * all. They are left believing they issued a compliant document.
 *
 * A false claim of filing and a silence about an unmet obligation are the same
 * failure wearing different clothes, and the silence is the harder one to
 * notice. This is the route that ends it.
 */
@RequireModule("accounting")
@Controller("accounting/compliance")
@UseGuards(JwtAuthGuard)
export class ComplianceController {
  constructor(
    private readonly compliance: ComplianceService,
    private readonly books: BooksService,
    private readonly transport: ComplianceTransportRegistry,
  ) {}

  @Get("documents/:documentType/:documentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:read")
  async getForDocument(
    @Param("documentType") documentType: string,
    @Param("documentId") documentId: string,
    @CurrentUser() user: CurrentUserContext,
  ) {
    const book = await this.books.findDefault(user.orgId);
    if (!book) throw new NotFoundException("Accounting is not enabled for this organisation");

    const states = await this.compliance.get(user.orgId, book.id, documentType, documentId);
    if (states.length === 0) {
      throw new NotFoundException("No compliance decision has been recorded for that document");
    }

    /*
      Every row, not the first one. A document can carry more than one: the
      decision is recorded against the transport that WANTS it (`irp`), and a
      submission against the transport that HANDLED it (`mock_irp`). Returning
      one of them would mean showing either the obligation or the attempt and
      never both — and which one you got would depend on row order.
    */
    return {
      states: states.map((state) => ({ ...state, ...describe(state) })),
      /* True only if some transport that actually files says so. */
      filed: states.some((state) => describe(state).filed),
      headline: overallHeadline(states),
      transport: this.transport.describe(),
    };
  }

  /**
   * Offer a document to whatever transport this deployment has.
   *
   * Explicit, and never part of posting. Reaching an external authority inside
   * the posting transaction would hold a pooled connection for the length of a
   * government outage, and enforcement is `off` precisely so that a founder
   * does not lose the ability to invoice when a portal is down. So filing is a
   * separate act with its own request.
   *
   * The facts sent are read from the posted document, never taken from the
   * request body: a caller able to supply its own totals could send a tax
   * authority a figure that differs from the ledger, and the discrepancy would
   * surface months later as a notice with this product's own submission as the
   * evidence against the tenant.
   */
  @Post("documents/:documentType/:documentId/submit")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:receivables:manage")
  @Idempotent("accounting.compliance.document.submit")
  async submitDocument(
    @Param("documentType") documentType: string,
    @Param("documentId") documentId: string,
    @CurrentUser() user: CurrentUserContext,
  ) {
    const book = await this.books.findDefault(user.orgId);
    if (!book) throw new NotFoundException("Accounting is not enabled for this organisation");

    const adapter = this.transport.resolve();
    if (!adapter) {
      /*
        409 rather than 501: this is a deployment that has not been given a
        connection, not a capability the product lacks, and the sentence has to
        leave the reader in no doubt that nothing was sent.
      */
      throw new ConflictException(
        "No e-invoice transport is configured for this deployment, so nothing was sent. " +
          "File this document directly with the authority.",
      );
    }

    const [state] = await this.compliance.get(user.orgId, book.id, documentType, documentId);
    if (!state) {
      throw new NotFoundException("No compliance decision has been recorded for that document");
    }
    if (state.status === "not_required") {
      throw new ConflictException(
        "This document is not reportable, so there is nothing to file.",
      );
    }

    const payload = await this.compliance.payloadForDocument(
      user.orgId,
      book.id,
      documentType,
      documentId,
    );
    if (!payload) {
      throw new ConflictException(
        "This document's details could not be read for filing. Only accounting's own AR " +
          "documents can be filed; a legacy invoice cannot.",
      );
    }

    const result = await this.compliance.submitToTransport(
      user.orgId,
      book.id,
      documentType,
      documentId,
      adapter,
      payload,
    );

    const states = await this.compliance.get(user.orgId, book.id, documentType, documentId);
    /*
      The row this adapter wrote, found by its transport rather than by
      position — the decision row for `irp` is still there beside it, and
      reading the wrong one would report a mock submission through the
      narrative of an obligation nobody acted on.
    */
    const written = states.find((state) => state.transport === adapter.transport);

    return {
      result,
      transport: this.transport.describe(),
      /*
        The narrative of what the adapter wrote, so a mock submission comes
        back saying "not filed" in the same response that reports it accepted.
      */
      ...(written ? describe(written) : {}),
    };
  }
}

/**
 * Transports that produce an acknowledgement and file nothing.
 *
 * Membership here is the difference between a test fixture and a fabricated
 * statutory record, so it is a list rather than a naming convention.
 */
const SYNTHETIC_TRANSPORTS = new Set(["mock_irp"]);

/**
 * One line for a document that may carry several compliance rows.
 *
 * A real filing wins, then an outstanding obligation, then whatever is left.
 * The order matters: a document with a `mock_irp` submission and an `irp`
 * obligation must lead with the obligation, because the mock filed nothing and
 * the duty is still outstanding.
 */
function overallHeadline(states: Array<Parameters<typeof describe>[0]>): string {
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
