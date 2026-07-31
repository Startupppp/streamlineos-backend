describe("ATP availability math", () => {
  function computeAvailable(onHand: number, committed: number, blocked: number, qualityHold: number): number {
    return onHand - committed - blocked - qualityHold;
  }

  function computeForecasted(onHand: number, incoming: number, outgoing: number): number {
    return onHand + incoming - outgoing;
  }

  describe("available", () => {
    it("subtracts all hold quantities from onHand", () => {
      expect(computeAvailable(100, 10, 5, 3)).toBe(82);
    });

    it("returns zero when everything is committed", () => {
      expect(computeAvailable(100, 100, 0, 0)).toBe(0);
    });

    it("can go negative when oversold", () => {
      expect(computeAvailable(10, 20, 0, 0)).toBe(-10);
    });

    it("handles all zeros", () => {
      expect(computeAvailable(0, 0, 0, 0)).toBe(0);
    });

    it("accounts for both blocked and quality hold independently", () => {
      expect(computeAvailable(50, 0, 25, 10)).toBe(15);
    });
  });

  describe("forecasted", () => {
    it("adds incoming and subtracts outgoing from onHand", () => {
      expect(computeForecasted(100, 50, 30)).toBe(120);
    });

    it("returns onHand when no open orders", () => {
      expect(computeForecasted(100, 0, 0)).toBe(100);
    });

    it("can go negative if outgoing exceeds onHand plus incoming", () => {
      expect(computeForecasted(10, 5, 20)).toBe(-5);
    });

    it("handles large incoming PO volumes", () => {
      expect(computeForecasted(0, 1000, 0)).toBe(1000);
    });
  });

  describe("available = onHand - committed - blocked - qualityHold", () => {
    it("each component independently reduces available", () => {
      const base = 100;
      expect(computeAvailable(base, 10, 0, 0)).toBe(90);
      expect(computeAvailable(base, 0, 10, 0)).toBe(90);
      expect(computeAvailable(base, 0, 0, 10)).toBe(90);
      expect(computeAvailable(base, 10, 10, 10)).toBe(70);
    });
  });
});
