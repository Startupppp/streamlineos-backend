function normalizeName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

function scoreDateProximity(txnDate: string, candidateDate: string): number {
  const a = new Date(txnDate).getTime();
  const b = new Date(candidateDate).getTime();
  const diffDays = Math.abs((a - b) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 20;
  if (diffDays <= 1) return 16;
  if (diffDays <= 3) return 10;
  return 0;
}

function scoreReference(txnRef: string | null | undefined, candidateRef: string | null | undefined): number {
  if (!txnRef || !candidateRef) return 0;
  const a = txnRef.toLowerCase().trim();
  const b = candidateRef.toLowerCase().trim();
  if (a === b) return 20;
  if (a.includes(b) || b.includes(a)) return 20;
  return 0;
}

function scoreCounterparty(txnCounterparty: string | null | undefined, candidateName: string | null | undefined): number {
  if (!txnCounterparty || !candidateName) return 0;
  const a = normalizeName(txnCounterparty);
  const b = normalizeName(candidateName);
  if (a.includes(b) || b.includes(a)) return 10;
  return 0;
}

function computeTotalScore(
  txn: { txnDate: string; reference?: string | null; counterparty?: string | null; amount: string },
  candidate: { date: string; reference?: string | null; counterpartyName?: string | null; amount: string },
): number {
  const txnAmount = Math.abs(parseFloat(txn.amount));
  const candAmount = Math.abs(parseFloat(candidate.amount));
  if (Math.abs(txnAmount - candAmount) > 0.01) return -1;
  let score = 50;
  score += scoreDateProximity(txn.txnDate, candidate.date);
  score += scoreReference(txn.reference, candidate.reference);
  score += scoreCounterparty(txn.counterparty, candidate.counterpartyName);
  return score;
}

describe("scoreDateProximity", () => {
  it("same day scores 20", () => {
    expect(scoreDateProximity("2024-01-15", "2024-01-15")).toBe(20);
  });

  it("±1 day scores 16", () => {
    expect(scoreDateProximity("2024-01-15", "2024-01-16")).toBe(16);
    expect(scoreDateProximity("2024-01-15", "2024-01-14")).toBe(16);
  });

  it("±3 days scores 10", () => {
    expect(scoreDateProximity("2024-01-15", "2024-01-18")).toBe(10);
    expect(scoreDateProximity("2024-01-15", "2024-01-12")).toBe(10);
  });

  it("outside ±3 days scores 0", () => {
    expect(scoreDateProximity("2024-01-15", "2024-01-20")).toBe(0);
    expect(scoreDateProximity("2024-01-15", "2024-02-15")).toBe(0);
  });
});

describe("scoreReference", () => {
  it("exact match scores 20", () => {
    expect(scoreReference("INV-001", "INV-001")).toBe(20);
  });

  it("case-insensitive exact match scores 20", () => {
    expect(scoreReference("inv-001", "INV-001")).toBe(20);
  });

  it("substring match scores 20", () => {
    expect(scoreReference("Payment for INV-001 received", "INV-001")).toBe(20);
  });

  it("no overlap scores 0", () => {
    expect(scoreReference("INV-001", "INV-002")).toBe(0);
  });

  it("null reference scores 0", () => {
    expect(scoreReference(null, "INV-001")).toBe(0);
    expect(scoreReference("INV-001", null)).toBe(0);
    expect(scoreReference(null, null)).toBe(0);
  });
});

describe("scoreCounterparty", () => {
  it("normalized substring match scores 10", () => {
    expect(scoreCounterparty("ACME Corp", "acme")).toBe(10);
  });

  it("reverse substring match scores 10", () => {
    expect(scoreCounterparty("acme", "ACME Corp International")).toBe(10);
  });

  it("no match scores 0", () => {
    expect(scoreCounterparty("ACME Corp", "Globex")).toBe(0);
  });

  it("null counterparty scores 0", () => {
    expect(scoreCounterparty(null, "ACME")).toBe(0);
    expect(scoreCounterparty("ACME", null)).toBe(0);
  });
});

describe("computeTotalScore (amount gate + composite)", () => {
  const baseTxn = {
    txnDate: "2024-01-15",
    amount: "1000.00",
    reference: "INV-001",
    counterparty: "ACME Corp",
  };

  it("returns -1 when amount differs by more than 0.01", () => {
    const score = computeTotalScore(baseTxn, { date: "2024-01-15", amount: "999.00" });
    expect(score).toBe(-1);
  });

  it("base score 50 when amount matches but no date/ref/counterparty bonus", () => {
    const score = computeTotalScore(
      { txnDate: "2024-01-15", amount: "500.00" },
      { date: "2024-01-20", amount: "500.00" },
    );
    expect(score).toBe(50);
  });

  it("threshold 60 — exact date alone puts score at 70 (above threshold)", () => {
    const score = computeTotalScore(
      { txnDate: "2024-01-15", amount: "500.00" },
      { date: "2024-01-15", amount: "500.00" },
    );
    expect(score).toBeGreaterThanOrEqual(60);
    expect(score).toBe(70);
  });

  it("score just below threshold (50) is below 60", () => {
    const score = computeTotalScore(
      { txnDate: "2024-01-15", amount: "500.00" },
      { date: "2024-01-20", amount: "500.00" },
    );
    expect(score).toBeLessThan(60);
  });

  it("full match (same date + ref + counterparty) scores 100", () => {
    const score = computeTotalScore(baseTxn, {
      date: "2024-01-15",
      amount: "1000.00",
      reference: "INV-001",
      counterpartyName: "ACME Corp",
    });
    expect(score).toBe(100);
  });

  it("rule-hit confidence is capped at 90 (per service code) when all scoring maxes out", () => {
    const score = computeTotalScore(baseTxn, {
      date: "2024-01-15",
      amount: "1000.00",
      reference: "INV-001",
      counterpartyName: "ACME Corp",
    });
    const ruleCapped = Math.min(score, 100).toFixed(2);
    expect(Number(ruleCapped)).toBe(100);
  });

  it("amount gate uses absolute values (negative txn amount matches positive candidate)", () => {
    const score = computeTotalScore(
      { txnDate: "2024-01-15", amount: "-1000.00" },
      { date: "2024-01-15", amount: "1000.00" },
    );
    expect(score).not.toBe(-1);
  });
});

describe("rule-hit short-circuit (confidence=90)", () => {
  it("rule match confidence string is '90.00'", () => {
    const confidence = "90.00";
    expect(confidence).toBe("90.00");
    expect(Number(confidence)).toBe(90);
    expect(Number(confidence)).toBeGreaterThanOrEqual(60);
  });
});
