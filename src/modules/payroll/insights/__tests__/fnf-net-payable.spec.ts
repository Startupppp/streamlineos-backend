function calcNetPayable(input: {
  basicDues?: number;
  leaveEncashment?: number;
  bonusDue?: number;
  reimbursementsDue?: number;
  deductions?: number;
  loanRecovery?: number;
  assetRecovery?: number;
  noticeRecovery?: number;
  otherDeductions?: number;
}): number {
  const basicDues = input.basicDues ?? 0;
  const leaveEncashment = input.leaveEncashment ?? 0;
  const bonusDue = input.bonusDue ?? 0;
  const reimbursementsDue = input.reimbursementsDue ?? 0;
  const deductions = input.deductions ?? 0;
  const loanRecovery = input.loanRecovery ?? 0;
  const assetRecovery = input.assetRecovery ?? 0;
  const noticeRecovery = input.noticeRecovery ?? 0;
  const otherDeductions = input.otherDeductions ?? 0;
  return (
    basicDues + leaveEncashment + bonusDue + reimbursementsDue
    - deductions - loanRecovery - assetRecovery - noticeRecovery - otherDeductions
  );
}

describe("FNF netPayable — 9-component formula", () => {
  it("sums all earnings components", () => {
    const result = calcNetPayable({
      basicDues: 50000,
      leaveEncashment: 10000,
      bonusDue: 5000,
      reimbursementsDue: 2000,
    });
    expect(result).toBe(67000);
  });

  it("subtracts all deduction components", () => {
    const result = calcNetPayable({
      basicDues: 100000,
      deductions: 5000,
      loanRecovery: 3000,
      assetRecovery: 2000,
      noticeRecovery: 10000,
      otherDeductions: 1000,
    });
    expect(result).toBe(79000);
  });

  it("full 9-component calculation", () => {
    const result = calcNetPayable({
      basicDues: 80000,
      leaveEncashment: 15000,
      bonusDue: 10000,
      reimbursementsDue: 5000,
      deductions: 8000,
      loanRecovery: 4000,
      assetRecovery: 2000,
      noticeRecovery: 6000,
      otherDeductions: 1000,
    });
    expect(result).toBe(89000);
  });

  it("defaults missing fields to zero", () => {
    const result = calcNetPayable({ basicDues: 50000 });
    expect(result).toBe(50000);
  });

  it("can produce negative net when deductions exceed earnings", () => {
    const result = calcNetPayable({
      basicDues: 5000,
      noticeRecovery: 30000,
    });
    expect(result).toBe(-25000);
  });

  it("old 5-field result is NOT equal to new 9-field result when extra fields are nonzero", () => {
    const oldCalc = (b: number, l: number, bo: number, d: number, lr: number) =>
      b + l + bo - d - lr;
    const newCalc = calcNetPayable;

    const params = {
      basicDues: 80000,
      leaveEncashment: 15000,
      bonusDue: 10000,
      reimbursementsDue: 5000,
      deductions: 8000,
      loanRecovery: 4000,
      assetRecovery: 2000,
      noticeRecovery: 6000,
      otherDeductions: 1000,
    };

    const oldResult = oldCalc(80000, 15000, 10000, 8000, 4000);
    const newResult = newCalc(params);
    expect(newResult).not.toBe(oldResult);
    expect(newResult).toBe(oldResult + 5000 - 2000 - 6000 - 1000);
  });
});
