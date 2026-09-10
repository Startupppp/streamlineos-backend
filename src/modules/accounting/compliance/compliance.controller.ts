import { Controller, Get, NotFoundException, Param, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { BooksService } from "../kernel/books.service";
import { ComplianceService } from "./compliance.service";

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

    const [state] = await this.compliance.get(user.orgId, book.id, documentType, documentId);
    if (!state) {
      throw new NotFoundException("No compliance decision has been recorded for that document");
    }

    return { ...state, ...describe(state) };
  }
}

/**
 * Transports that produce an acknowledgement and file nothing.
 *
 * Membership here is the difference between a test fixture and a fabricated
 * statutory record, so it is a list rather than a naming convention.
 */
const SYNTHETIC_TRANSPORTS = new Set(["mock_irp"]);

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
