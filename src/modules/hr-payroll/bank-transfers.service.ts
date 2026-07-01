import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { bankTransfers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { BankTransferEntry } from "../../db/schema/hr/bank-transfers";

type BankTransferInsert = typeof bankTransfers.$inferInsert;

function generateNeftCsv(transfer: typeof bankTransfers.$inferSelect): string {
  const header = "SrNo,BeneficiaryName,AccountNumber,IFSCCode,Amount,Remarks";
  const rows = (transfer.entries as BankTransferEntry[]).map((e, i) =>
    `${i + 1},"${e.employeeName}","${e.bankAccount}","${e.ifscCode}",${e.amount},"Salary ${transfer.month}"`
  );
  return [header, ...rows].join("\n");
}

@Injectable()
export class BankTransfersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string) {
    return this.db
      .select()
      .from(bankTransfers)
      .where(eq(bankTransfers.orgId, orgId))
      .orderBy(desc(bankTransfers.createdAt))
      .limit(50);
  }

  async create(orgId: string, userId: string, data: Partial<BankTransferInsert>) {
    const [item] = await this.db
      .insert(bankTransfers)
      .values({ ...data, orgId, createdBy: userId } as BankTransferInsert)
      .returning();
    return item;
  }

  async updateStatus(orgId: string, id: number, data: { status: string; referenceNo?: string }) {
    const [item] = await this.db
      .update(bankTransfers)
      .set({
        status: data.status,
        referenceNo: data.referenceNo,
        processedAt: data.status === "COMPLETED" ? new Date() : undefined,
      })
      .where(and(eq(bankTransfers.id, id), eq(bankTransfers.orgId, orgId)))
      .returning();
    if (!item) throw new NotFoundException("Bank transfer not found");
    return item;
  }

  async generateFile(orgId: string, id: number) {
    const [transfer] = await this.db
      .select()
      .from(bankTransfers)
      .where(and(eq(bankTransfers.id, id), eq(bankTransfers.orgId, orgId)));
    if (!transfer) throw new NotFoundException("Bank transfer not found");
    return { format: "NEFT_CSV", data: generateNeftCsv(transfer), month: transfer.month };
  }
}
