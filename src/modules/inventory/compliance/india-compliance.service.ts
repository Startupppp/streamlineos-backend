import { createHash } from "node:crypto";
import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invComplianceDocuments } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import { type Db } from "../../../db/drizzle.module";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { randomUUID } from "node:crypto";
import {
  COMPLIANCE_EVENTS,
  executeComplianceCall,
  STUB_COMPLIANCE_ADAPTER,
  productionBlockedStubAdapter,
  unconfiguredLiveAdapter,
  type ComplianceAdapter,
  type ComplianceDocumentKind,
  type ComplianceRequest,
  type ComplianceResult,
} from "./india-compliance-adapter";

/**
 * E5 — the only thing that calls an adapter, and the only thing that decides
 * whether to.
 *
 * Three rules hold here and nowhere else, so there is exactly one place to read
 * them:
 *
 *   1. **Off means nothing happens.** Not "the call is made and discarded" —
 *      the payload is never constructed and no row is written. `SKIPPED` is a
 *      real answer the caller can act on, and it is what makes the unit's
 *      "flag off: no outbound IRP" true by construction.
 *   2. **The ledger is untouched.** This service imports no stock engine, no
 *      reservation service and no journal poster. Registering an e-invoice
 *      cannot move stock, because there is nothing here that could.
 *   3. **The event follows the acknowledgement.** `einvoice.registered` is
 *      emitted after a provider says yes, never before and never on a failure —
 *      an event that fires on the attempt tells every consumer a filing exists
 *      when it does not.
 */
@Injectable()
export class IndiaComplianceService {
  private readonly logger = new Logger(IndiaComplianceService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly settingsService: InventorySettingsService,
    private readonly audit: InventoryAuditService,
  ) {}

  /**
   * `stub` is the only adapter that exists. Any other name resolves to one that
   * refuses with NO_CREDENTIALS — loudly, rather than falling back, because a
   * silent fallback is how a rehearsal gets mistaken for a filing.
   *
   * INV-25. In production the stub refuses too. Every gate above this one is a
   * *tenant* setting — the `gst` pack, the two enable flags, and
   * `complianceAdapter` itself, which is a writable string defaulting to
   * `"stub"` — so nothing outside this line stops a live deployment issuing
   * invented IRNs to a customer who turned the feature on. The pack's rule is
   * that a fake compliance identifier must never be presentable as a filing,
   * and the only way to hold that is for production to be unable to mint one.
   */
  private adapterFor(code: string): ComplianceAdapter {
    if (code !== "stub") return unconfiguredLiveAdapter(code);
    return this.config.NODE_ENV === "production"
      ? productionBlockedStubAdapter()
      : STUB_COMPLIANCE_ADAPTER;
  }

  /**
   * Whether this organisation has asked for this document kind.
   *
   * The `gst` pack gates both: capturing HSN codes is a prerequisite for
   * describing a line to a tax authority, so an organisation with the pack off
   * has nothing to send even if it flipped the adapter flag.
   */
  private async enabledFor(orgId: string, kind: ComplianceDocumentKind): Promise<boolean> {
    const settings = await this.settingsService.get(orgId);
    if (!settings.packs.gst) return false;
    return kind === "EINVOICE" ? settings.gstEinvoiceEnabled : settings.gstEwaybillEnabled;
  }

  /**
   * A digest of what is being filed.
   *
   * Sorted and explicit rather than `JSON.stringify` of the whole request: key
   * order in an object literal is an accident of construction, and a hash that
   * changed when somebody reordered a field would make every amended document
   * look amended when it was not.
   */
  static payloadHash(request: Omit<ComplianceRequest, "payloadHash">): string {
    const canonical = [
      request.kind,
      request.sourceType,
      request.sourceId,
      request.documentNumber,
      ...request.lines
        .map((l) => `${l.description}|${l.hsnCode ?? ""}|${l.quantity}|${l.taxableValue}`)
        .sort(),
    ].join("\n");
    return createHash("sha256").update(canonical).digest("hex");
  }

  async register(
    orgId: string,
    userId: string,
    input: Omit<ComplianceRequest, "payloadHash">,
  ): Promise<
    | { status: "SKIPPED"; reason: string }
    | { status: "REGISTERED"; externalId: string; isLive: boolean }
    | { status: "FAILED"; code: string; message: string }
  > {
    if (!(await this.enabledFor(orgId, input.kind))) {
      // Nothing is constructed, nothing is stored, nothing leaves the process.
      return { status: "SKIPPED", reason: `${input.kind} is not enabled for this organisation` };
    }

    const settings = await this.settingsService.get(orgId);
    const adapter = this.adapterFor(settings.complianceAdapter);
    const payloadHash = IndiaComplianceService.payloadHash(input);

    // The same document filed twice is one filing. An *edited* document hashes
    // differently and is therefore a different row, which is what stops an
    // amended invoice inheriting the original's IRN.
    const existing = await this.db.query.invComplianceDocuments.findFirst({
      where: and(
        eq(invComplianceDocuments.orgId, orgId),
        eq(invComplianceDocuments.kind, input.kind),
        eq(invComplianceDocuments.sourceType, input.sourceType),
        eq(invComplianceDocuments.sourceId, input.sourceId),
        eq(invComplianceDocuments.payloadHash, payloadHash),
      ),
      columns: { id: true, status: true, externalId: true, adapterIsLive: true },
    });
    if (existing?.status === "REGISTERED" && existing.externalId) {
      return {
        status: "REGISTERED",
        externalId: existing.externalId,
        isLive: existing.adapterIsLive,
      };
    }

    const request: ComplianceRequest = { ...input, payloadHash };
    // Through the executor, so the retry ladder and the ten-second deadline
    // actually run. Calling `adapter.register` directly is what left both
    // exported, unit-tested and reachable from nothing: one refusal was
    // recorded as final, and a portal that never answered held this request
    // open with no deadline of its own. A throw comes back as a FAILED result.
    const result: ComplianceResult = await executeComplianceCall(() => adapter.register(request));

    await this.db.transaction(async (tx) => {
      await tx
        .insert(invComplianceDocuments)
        .values({
          orgId,
          kind: input.kind,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          documentNumber: input.documentNumber,
          payloadHash,
          adapterCode: adapter.code,
          adapterIsLive: adapter.isLive,
          status: result.status,
          externalId: result.status === "FAILED" ? null : result.externalId,
          acknowledgedAt: result.status === "FAILED" ? null : new Date(result.acknowledgedAt),
          errorCode: result.status === "FAILED" ? result.code : null,
          errorMessage: result.status === "FAILED" ? result.message : null,
          attempts: 1,
          rawResponse: result.status === "FAILED" ? null : result.raw,
          createdBy: userId,
        })
        .onConflictDoUpdate({
          target: [
            invComplianceDocuments.orgId,
            invComplianceDocuments.kind,
            invComplianceDocuments.sourceType,
            invComplianceDocuments.sourceId,
            invComplianceDocuments.payloadHash,
          ],
          set: {
            status: result.status,
            externalId: result.status === "FAILED" ? null : result.externalId,
            acknowledgedAt: result.status === "FAILED" ? null : new Date(result.acknowledgedAt),
            errorCode: result.status === "FAILED" ? result.code : null,
            errorMessage: result.status === "FAILED" ? result.message : null,
            rawResponse: result.status === "FAILED" ? null : result.raw,
          },
        });

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: `compliance.${input.kind.toLowerCase()}.${result.status.toLowerCase()}`,
        resourceType: input.sourceType,
        resourceId: input.sourceId,
        after: {
          adapter: adapter.code,
          isLive: adapter.isLive,
          externalId: result.status === "FAILED" ? null : result.externalId,
        },
      });

      // Only after the provider said yes. An event on the attempt would tell
      // every consumer a filing exists when it does not.
      if (result.status === "REGISTERED") {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: input.sourceType,
          aggregateId: input.sourceId,
          aggregateVersion: 1,
          eventType:
            input.kind === "EINVOICE"
              ? COMPLIANCE_EVENTS.EINVOICE_REGISTERED
              : COMPLIANCE_EVENTS.EWAYBILL_GENERATED,
          payload: {
            kind: input.kind,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            documentNumber: input.documentNumber,
            externalId: result.externalId,
            adapter: adapter.code,
            // On the event too, so a consumer cannot mistake a rehearsal for a filing.
            isLive: adapter.isLive,
          },
          occurredAt: new Date(),
        });
      }
    });

    if (result.status === "FAILED") {
      this.logger.warn(
        `${input.kind} for ${input.sourceType}:${input.sourceId} failed via ${adapter.code}: ${result.code}`,
      );
      return { status: "FAILED", code: result.code, message: result.message };
    }
    return { status: "REGISTERED", externalId: result.externalId, isLive: adapter.isLive };
  }

  async cancel(
    orgId: string,
    userId: string,
    input: { kind: ComplianceDocumentKind; sourceType: string; sourceId: string; reason: string },
  ): Promise<{ status: "SKIPPED" | "CANCELLED" | "FAILED"; message?: string }> {
    if (!(await this.enabledFor(orgId, input.kind))) {
      return { status: "SKIPPED", message: `${input.kind} is not enabled for this organisation` };
    }

    const doc = await this.db.query.invComplianceDocuments.findFirst({
      where: and(
        eq(invComplianceDocuments.orgId, orgId),
        eq(invComplianceDocuments.kind, input.kind),
        eq(invComplianceDocuments.sourceType, input.sourceType),
        eq(invComplianceDocuments.sourceId, input.sourceId),
        eq(invComplianceDocuments.status, "REGISTERED"),
      ),
      columns: { id: true, externalId: true, adapterCode: true, adapterIsLive: true },
    });
    if (!doc?.externalId) {
      throw new BadRequestException("There is no registered document to cancel.");
    }

    // Captured before the closure: the guard above narrows `doc.externalId` to
    // a string, but that narrowing does not survive into a callback, because
    // the compiler cannot know `doc` is unchanged by the time it runs.
    const externalId = doc.externalId;
    const adapter = this.adapterFor(doc.adapterCode);
    const result = await executeComplianceCall(() =>
      adapter.cancel({
        kind: input.kind,
        externalId,
        reason: input.reason,
      }),
    );

    if (result.status === "FAILED") return { status: "FAILED", message: result.message };

    await this.db.transaction(async (tx) => {
      await tx
        .update(invComplianceDocuments)
        .set({ status: "CANCELLED", errorCode: null, errorMessage: null })
        .where(eq(invComplianceDocuments.id, doc.id));

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: `compliance.${input.kind.toLowerCase()}.cancelled`,
        resourceType: input.sourceType,
        resourceId: input.sourceId,
        after: { externalId: doc.externalId, reason: input.reason },
      });

      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: input.sourceType,
        aggregateId: input.sourceId,
        aggregateVersion: 2,
        eventType: COMPLIANCE_EVENTS.EINVOICE_CANCELLED,
        payload: {
          kind: input.kind,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          externalId: doc.externalId,
          reason: input.reason,
          isLive: doc.adapterIsLive,
        },
        occurredAt: new Date(),
      });
    });

    return { status: "CANCELLED" };
  }

  /** What has been filed for one document, for the screen that shows it. */
  async documentsFor(orgId: string, sourceType: string, sourceId: string) {
    return this.db
      .select({
        id: invComplianceDocuments.id,
        kind: invComplianceDocuments.kind,
        status: invComplianceDocuments.status,
        externalId: invComplianceDocuments.externalId,
        adapterCode: invComplianceDocuments.adapterCode,
        adapterIsLive: invComplianceDocuments.adapterIsLive,
        acknowledgedAt: invComplianceDocuments.acknowledgedAt,
        errorCode: invComplianceDocuments.errorCode,
        errorMessage: invComplianceDocuments.errorMessage,
        createdAt: invComplianceDocuments.createdAt,
      })
      .from(invComplianceDocuments)
      .where(
        and(
          eq(invComplianceDocuments.orgId, orgId),
          eq(invComplianceDocuments.sourceType, sourceType),
          eq(invComplianceDocuments.sourceId, sourceId),
        ),
      );
  }
}
