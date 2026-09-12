import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
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
import {
  documentComplianceResponseSchema,
  submitDocumentResponseSchema,
} from "./dto/compliance-response.schemas";
import {
  describe,
  overallHeadline,
  type ComplianceNarrative,
} from "./compliance-narrative";

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
  @ResponseSchema(documentComplianceResponseSchema)
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
  @ResponseSchema(submitDocumentResponseSchema)
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


