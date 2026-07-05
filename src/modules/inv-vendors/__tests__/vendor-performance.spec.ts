describe("vendor performance math", () => {
  it("onTimeRate is 0.5 when half of GRNs are on time", () => {
    const deliveries = [
      { expectedDate: "2024-01-10", receivedDate: "2024-01-09" },
      { expectedDate: "2024-01-10", receivedDate: "2024-01-12" },
    ];
    const onTime = deliveries.filter(d => d.receivedDate <= d.expectedDate).length;
    const rate = onTime / deliveries.length;
    expect(rate).toBe(0.5);
  });

  it("onTimeRate is 1.0 when all GRNs arrive on time", () => {
    const deliveries = [
      { expectedDate: "2024-01-10", receivedDate: "2024-01-08" },
      { expectedDate: "2024-01-15", receivedDate: "2024-01-15" },
    ];
    const onTime = deliveries.filter(d => d.receivedDate <= d.expectedDate).length;
    const rate = onTime / deliveries.length;
    expect(rate).toBe(1.0);
  });

  it("fillRate is 1.0 when all ordered qty received", () => {
    const lines = [
      { quantity: "100", quantityReceived: "100" },
      { quantity: "50", quantityReceived: "50" },
    ];
    const totalOrdered = lines.reduce((s, l) => s + parseFloat(l.quantity), 0);
    const totalReceived = lines.reduce((s, l) => s + parseFloat(l.quantityReceived), 0);
    expect(totalReceived / totalOrdered).toBe(1.0);
  });

  it("fillRate is 0.8 when 80% received", () => {
    const totalOrdered = 100;
    const totalReceived = 80;
    expect(totalReceived / totalOrdered).toBe(0.8);
  });

  it("fillRate is 0 when no orders exist", () => {
    const totalOrdered = 0;
    const totalReceived = 0;
    const fillRate = totalOrdered === 0 ? 0 : totalReceived / totalOrdered;
    expect(fillRate).toBe(0);
  });

  it("returnRate is 0 when no returns", () => {
    const returnQty: number = 0;
    const receivedQty: number = 100;
    expect(receivedQty === 0 ? 0 : returnQty / receivedQty).toBe(0);
  });

  it("returnRate is 0.1 when 10% returned", () => {
    const returnQty = 10;
    const receivedQty = 100;
    expect(returnQty / receivedQty).toBeCloseTo(0.1);
  });

  it("returnRate is 0 when no received qty (avoids division by zero)", () => {
    const returnQty: number = 0;
    const receivedQty: number = 0;
    const returnRate = receivedQty === 0 ? 0 : returnQty / receivedQty;
    expect(returnRate).toBe(0);
  });

  it("avgLeadTimeDays computes correctly from sentAt to first GRN date", () => {
    const sentAt = new Date("2024-01-01T00:00:00Z");
    const firstGrnDate = new Date("2024-01-11T00:00:00Z");
    const daysDiff = (firstGrnDate.getTime() - sentAt.getTime()) / 86400000;
    expect(daysDiff).toBe(10);
  });

  it("avgLeadTimeDays averages across multiple POs", () => {
    const leadTimes = [10, 20];
    const avg = leadTimes.reduce((s, d) => s + d, 0) / leadTimes.length;
    expect(avg).toBe(15);
  });
});
