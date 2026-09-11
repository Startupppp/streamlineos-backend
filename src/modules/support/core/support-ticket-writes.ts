import { and, eq } from "drizzle-orm";
import {
  organizationMembers,
  supportTicketAttachments,
  supportTicketMessages,
  supportTickets,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import type { CreateTicketInput, TicketAttachmentInput, TicketPriority } from "./dto/support.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface TicketSource {
  channel: string;
  messageId?: string | null;
  requesterEmail?: string | null;
  requesterName?: string | null;
}

export interface InsertTicketParams {
  orgId: string;
  userId: string;
  input: CreateTicketInput & { attachments?: TicketAttachmentInput[] };
  priority: TicketPriority;
  assigneeId: string | undefined;
  membershipId: number;
  firstResponseDueAt: Date;
  resolutionDueAt: Date;
  source?: TicketSource;
}

export async function resolveActiveMembershipId(
  db: Db | Tx,
  orgId: string,
  userId: string | null | undefined,
): Promise<number | null> {
  if (!userId) return null;
  const member = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.userId, userId),
      eq(organizationMembers.status, "ACTIVE"),
    ),
    columns: { id: true },
  });
  return member?.id ?? null;
}

export async function insertTicketWithOpeningMessage(tx: Db | Tx, params: InsertTicketParams) {
  const {
    orgId,
    userId,
    input,
    priority,
    assigneeId,
    membershipId,
    firstResponseDueAt,
    resolutionDueAt,
    source,
  } = params;

  const [row] = await tx
    .insert(supportTickets)
    .values({
      orgId,
      title: input.title,
      category: input.category ?? null,
      description: input.description ?? null,
      clientId: input.clientId ?? null,
      priority,
      assigneeMembershipId: await resolveActiveMembershipId(tx, orgId, assigneeId),
      slaDeadline: resolutionDueAt,
      firstResponseDueAt,
      createdByMembershipId: membershipId,
      sourceChannel: source?.channel ?? "web",
      sourceMessageId: source?.messageId ?? null,
      requesterEmail: source?.requesterEmail ?? null,
      requesterName: source?.requesterName ?? null,
    })
    .returning();

  if (input.attachments && input.attachments.length > 0) {
    const [openingMessage] = await tx
      .insert(supportTicketMessages)
      .values({
        orgId,
        ticketId: row.id,
        authorId: userId,
        body: input.description?.trim() || input.title,
        isInternal: false,
        sourceChannel: source?.channel ?? "web",
        sourceMessageId: source?.messageId ?? null,
        sourceContactEmail: source?.requesterEmail ?? null,
        sourceContactName: source?.requesterName ?? null,
      })
      .returning({ id: supportTicketMessages.id });
    if (!openingMessage) throw new Error("Failed to create opening message");
    await tx.insert(supportTicketAttachments).values(
      input.attachments.map((a) => ({
        orgId,
        messageId: openingMessage.id,
        fileName: a.fileName,
        fileUrl: a.fileUrl,
        fileSize: a.fileSize,
        mimeType: a.mimeType,
      })),
    );
  }

  return row;
}
