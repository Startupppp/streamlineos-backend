import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { taxDeclarations, investmentProofs } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

type DeclarationInsert = typeof taxDeclarations.$inferInsert;
type ProofInsert = typeof investmentProofs.$inferInsert;

@Injectable()
export class TaxService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listByOrg(orgId: string, year?: string) {
    return this.db
      .select()
      .from(taxDeclarations)
      .where(
        year
          ? and(eq(taxDeclarations.orgId, orgId), eq(taxDeclarations.financialYear, year))
          : eq(taxDeclarations.orgId, orgId),
      )
      .orderBy(desc(taxDeclarations.createdAt))
      .limit(100);
  }

  listMine(orgId: string, userId: string) {
    return this.db
      .select()
      .from(taxDeclarations)
      .where(and(eq(taxDeclarations.orgId, orgId), eq(taxDeclarations.userId, userId)))
      .orderBy(desc(taxDeclarations.createdAt))
      .limit(10);
  }

  async createOrUpdate(orgId: string, userId: string, data: Partial<DeclarationInsert>) {
    const existing = await this.db
      .select({ id: taxDeclarations.id })
      .from(taxDeclarations)
      .where(
        and(
          eq(taxDeclarations.orgId, orgId),
          eq(taxDeclarations.userId, userId),
          eq(taxDeclarations.financialYear, (data.financialYear as string) ?? ""),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      const [updated] = await this.db
        .update(taxDeclarations)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(taxDeclarations.id, existing[0].id), eq(taxDeclarations.orgId, orgId)))
        .returning();
      return updated;
    }

    const [created] = await this.db
      .insert(taxDeclarations)
      .values({ ...data, orgId, userId } as DeclarationInsert)
      .returning();
    return created;
  }

  async verify(orgId: string, id: number, verifierId: string) {
    const [item] = await this.db
      .update(taxDeclarations)
      .set({ status: "VERIFIED", verifiedBy: verifierId, verifiedAt: new Date() })
      .where(and(eq(taxDeclarations.id, id), eq(taxDeclarations.orgId, orgId)))
      .returning();
    if (!item) throw new NotFoundException("Tax declaration not found");
    return item;
  }

  async addProof(orgId: string, declarationId: number, data: Partial<ProofInsert>) {
    const [declaration] = await this.db
      .select({ id: taxDeclarations.id })
      .from(taxDeclarations)
      .where(and(eq(taxDeclarations.id, declarationId), eq(taxDeclarations.orgId, orgId)))
      .limit(1);
    if (!declaration) throw new NotFoundException("Tax declaration not found");
    const [item] = await this.db
      .insert(investmentProofs)
      .values({ ...data, orgId, declarationId } as ProofInsert)
      .returning();
    return item;
  }

  async listProofs(orgId: string, declarationId: number) {
    const [declaration] = await this.db
      .select({ id: taxDeclarations.id })
      .from(taxDeclarations)
      .where(and(eq(taxDeclarations.id, declarationId), eq(taxDeclarations.orgId, orgId)))
      .limit(1);
    if (!declaration) throw new NotFoundException("Tax declaration not found");
    return this.db
      .select()
      .from(investmentProofs)
      .where(and(eq(investmentProofs.declarationId, declarationId), eq(investmentProofs.orgId, orgId)))
      .orderBy(desc(investmentProofs.createdAt));
  }
}
