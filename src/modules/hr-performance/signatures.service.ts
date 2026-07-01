import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ne } from "drizzle-orm";
import { signatureRequests } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

type Signer = { userId: string; order: number; signedAt?: string; signatureUrl?: string; status: string };

@Injectable()
export class SignaturesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listSent(orgId: string, userId: string) {
    return this.db
      .select()
      .from(signatureRequests)
      .where(and(eq(signatureRequests.orgId, orgId), eq(signatureRequests.requestedBy, userId)))
      .orderBy(desc(signatureRequests.createdAt))
      .limit(50);
  }

  async listReceived(orgId: string, userId: string) {
    const rows = await this.db
      .select()
      .from(signatureRequests)
      .where(and(eq(signatureRequests.orgId, orgId), ne(signatureRequests.status, "VOIDED")))
      .orderBy(desc(signatureRequests.createdAt))
      .limit(50);

    return rows.filter((row) =>
      (row.signers as Signer[]).some((s) => s.userId === userId && s.status === "PENDING"),
    );
  }

  async create(
    orgId: string,
    requestedBy: string,
    data: {
      title: string;
      documentType: string;
      documentUrl: string;
      expiresAt?: string;
      signers: Signer[];
    },
  ) {
    const [record] = await this.db
      .insert(signatureRequests)
      .values({
        orgId,
        requestedBy,
        title: data.title,
        documentType: data.documentType,
        documentUrl: data.documentUrl,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        signers: data.signers,
        status: "PENDING",
        auditTrail: [{ action: "CREATED", userId: requestedBy, timestamp: new Date().toISOString() }],
      })
      .returning();
    return record;
  }

  async sign(orgId: string, id: number, userId: string, signatureUrl: string) {
    const record = await this.db.query.signatureRequests.findFirst({
      where: and(eq(signatureRequests.id, id), eq(signatureRequests.orgId, orgId)),
    });
    if (!record) throw new NotFoundException("Signature request not found.");

    const updatedSigners = (record.signers as Signer[]).map((s) =>
      s.userId === userId
        ? { ...s, signedAt: new Date().toISOString(), signatureUrl, status: "SIGNED" }
        : s,
    );

    const allSigned = updatedSigners.every((s) => s.status === "SIGNED");
    const updatedTrail = [
      ...(record.auditTrail as { action: string; userId: string; timestamp: string }[]),
      { action: "SIGNED", userId, timestamp: new Date().toISOString() },
    ];

    const [updated] = await this.db
      .update(signatureRequests)
      .set({
        signers: updatedSigners,
        status: allSigned ? "COMPLETED" : record.status,
        completedAt: allSigned ? new Date() : null,
        auditTrail: updatedTrail,
      })
      .where(and(eq(signatureRequests.id, id), eq(signatureRequests.orgId, orgId)))
      .returning();

    return updated;
  }

  async void(orgId: string, id: number) {
    const [updated] = await this.db
      .update(signatureRequests)
      .set({ status: "VOIDED" })
      .where(and(eq(signatureRequests.id, id), eq(signatureRequests.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Signature request not found.");
    return updated;
  }
}
