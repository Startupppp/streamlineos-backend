export type Form16Status = "missing" | "uploaded" | "released";

export function isFinancialYear(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return false;
  return (Number(match[1]) + 1) % 100 === Number(match[2]);
}

export function financialYearMonths(financialYear: string): { from: string; to: string } {
  const start = Number(financialYear.slice(0, 4));
  return { from: `${start}-04`, to: `${start + 1}-03` };
}

type Person = { employeeName: string | null; email: string | null };
type Document = {
  userMembershipId: number;
  status: "uploaded" | "released";
  fileName: string;
  fileSizeBytes: number;
  uploadedAt: Date;
  releasedAt: Date | null;
};

export function mergeForm16Rows(payeeIds: number[], documents: Document[], people: Map<number, Person>) {
  const byMember = new Map(documents.map((doc) => [doc.userMembershipId, doc]));
  const memberIds = new Set([...payeeIds, ...byMember.keys()]);
  const rows = [...memberIds].map((id) => {
    const person = people.get(id);
    const doc = byMember.get(id);
    const status: Form16Status = doc?.status ?? "missing";
    return {
      userMembershipId: id,
      employeeName: person?.employeeName ?? null,
      email: person?.email ?? null,
      status,
      fileName: doc?.fileName ?? null,
      fileSizeBytes: doc?.fileSizeBytes ?? null,
      uploadedAt: doc?.uploadedAt ?? null,
      releasedAt: doc?.releasedAt ?? null,
    };
  });
  rows.sort((a, b) => (a.employeeName ?? "").localeCompare(b.employeeName ?? "") || a.userMembershipId - b.userMembershipId);
  const counts = { missing: 0, uploaded: 0, released: 0 };
  for (const row of rows) counts[row.status] += 1;
  return { rows, counts };
}
