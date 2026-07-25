/**
 * Pure helpers for manager inbox action counting (no Nest DI).
 */

function actionCount(input: {
  pendingReimbursements: number;
  pendingLoans: number;
  taxDeclarationStatus: string | null;
}): number {
  const taxNeedsReview = input.taxDeclarationStatus === "SUBMITTED";
  return (
    input.pendingReimbursements +
    input.pendingLoans +
    (taxNeedsReview ? 1 : 0)
  );
}

describe("manager inbox action count", () => {
  it("counts pending reimb + loans + submitted tax", () => {
    expect(
      actionCount({
        pendingReimbursements: 2,
        pendingLoans: 1,
        taxDeclarationStatus: "SUBMITTED",
      }),
    ).toBe(4);
  });

  it("ignores draft tax and approved loans", () => {
    expect(
      actionCount({
        pendingReimbursements: 0,
        pendingLoans: 0,
        taxDeclarationStatus: "DRAFT",
      }),
    ).toBe(0);
  });
});
