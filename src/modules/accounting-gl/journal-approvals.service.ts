import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { journalEntries, finApprovalRequests } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import type { ApprovalDecisionInput } from "./dto/journal-approvals.schemas";

@Injectable()
export class JournalApprovalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async submitForApproval(orgId: string, userId: string, entryId: number) {
    const entry = await this.db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.id, entryId), eq(journalEntries.orgId, orgId)))
      .limit(1);
    if (!entry[0]) throw new NotFoundException("Journal entry not found");
    if (entry[0].status !== "DRAFT") {
      throw new BadRequestException(`Only DRAFT entries can be submitted for approval (current: ${entry[0].status})`);
    }

    const existing = await this.db
      .select({ id: finApprovalRequests.id })
      .from(finApprovalRequests)
      .where(
        and(
          eq(finApprovalRequests.orgId, orgId),
          eq(finApprovalRequests.recordType, "MANUAL_JOURNAL"),
          eq(finApprovalRequests.recordId, entryId),
          eq(finApprovalRequests.status, "PENDING"),
        ),
      )
      .limit(1);
    if (existing.length > 0) throw new ConflictException("An approval request is already pending for this entry");

    await this.db.transaction(async (tx) => {
      await tx
        .update(journalEntries)
        .set({ status: "PENDING_APPROVAL" })
        .where(and(eq(journalEntries.id, entryId), eq(journalEntries.orgId, orgId)));

      await tx.insert(finApprovalRequests).values({
        orgId,
        recordType: "MANUAL_JOURNAL",
        recordId: entryId,
        status: "PENDING",
        requestedBy: userId,
      });
    });

    return { entryId, status: "PENDING_APPROVAL" };
  }

  async approveJournal(orgId: string, userId: string, entryId: number, input: ApprovalDecisionInput) {
    return this.decideJournal(orgId, userId, entryId, "APPROVED", input.comment);
  }

  async rejectJournal(orgId: string, userId: string, entryId: number, input: ApprovalDecisionInput) {
    return this.decideJournal(orgId, userId, entryId, "REJECTED", input.comment);
  }

  private async decideJournal(
    orgId: string,
    userId: string,
    entryId: number,
    decision: "APPROVED" | "REJECTED",
    comment: string | undefined,
  ) {
    const entry = await this.db
      .select({ id: journalEntries.id, orgId: journalEntries.orgId, createdBy: journalEntries.createdBy })
      .from(journalEntries)
      .where(and(eq(journalEntries.id, entryId), eq(journalEntries.orgId, orgId)))
      .limit(1);
    if (!entry[0]) throw new NotFoundException("Journal entry not found");

    const approvalRows = await this.db
      .select({ id: finApprovalRequests.id })
      .from(finApprovalRequests)
      .where(
        and(
          eq(finApprovalRequests.orgId, orgId),
          eq(finApprovalRequests.recordType, "MANUAL_JOURNAL"),
          eq(finApprovalRequests.recordId, entryId),
          eq(finApprovalRequests.status, "PENDING"),
        ),
      )
      .limit(1);
    const [approvalRow] = approvalRows;
    if (!approvalRow) throw new NotFoundException("No pending approval request found for this entry");

    const newEntryStatus = "DRAFT";

    await this.db.transaction(async (tx) => {
      await tx
        .update(finApprovalRequests)
        .set({ status: decision, decidedBy: userId, decidedAt: new Date(), decisionComment: comment ?? null })
        .where(and(eq(finApprovalRequests.id, approvalRow.id)));

      await tx
        .update(journalEntries)
        .set({
          status: newEntryStatus,
          ...(decision === "APPROVED" ? { approvedBy: userId, approvedAt: new Date() } : {}),
        })
        .where(and(eq(journalEntries.id, entryId), eq(journalEntries.orgId, orgId)));
    });

    const targetUserIds = [entry[0].createdBy];

    void this.dispatch.emit({
      eventKey: "accounting.approval.decided",
      orgId,
      actorUserId: userId,
      targetUserIds,
      entityType: "journal_entry",
      entityId: String(entryId),
      title: `Journal ${decision === "APPROVED" ? "Approved" : "Rejected"}`,
      message: `Journal entry #${entryId} has been ${decision.toLowerCase()}.`,
    });

    return { entryId, decision, entryStatus: newEntryStatus };
  }
}
