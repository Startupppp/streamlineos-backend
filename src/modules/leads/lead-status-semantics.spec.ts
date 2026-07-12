import { resolveLeadStatusSemantics } from "./lead-status-semantics";

describe("resolveLeadStatusSemantics", () => {
  it("returns fallback values when no options provided", () => {
    const result = resolveLeadStatusSemantics([]);
    expect(result).toEqual({
      convertedKeys: ["CONVERTED"],
      lostKeys: ["LOST"],
      activeKeys: ["NEW", "CONTACTED", "INTERESTED", "QUALIFIED"],
      slaOpenKeys: ["NEW", "CONTACTED", "INTERESTED", "QUALIFIED"],
    });
  });

  it("classifies terminal+non-lost as converted, terminal+lost as lost, non-terminal as active", () => {
    const result = resolveLeadStatusSemantics([
      { key: "WON", isTerminal: true, metadata: null },
      { key: "LOST", isTerminal: true, metadata: { semantic: "lost" } },
      { key: "OPEN", isTerminal: false, metadata: null },
    ]);
    expect(result).toEqual({
      convertedKeys: ["WON"],
      lostKeys: ["LOST"],
      activeKeys: ["OPEN"],
      slaOpenKeys: ["OPEN"],
    });
  });

  it("falls back to literal convertedKeys/lostKeys when no terminal options exist, but uses actual activeKeys", () => {
    const result = resolveLeadStatusSemantics([
      { key: "NEW", isTerminal: false, metadata: null },
      { key: "IN_PROGRESS", isTerminal: false, metadata: null },
    ]);
    expect(result.convertedKeys).toEqual(["CONVERTED"]);
    expect(result.lostKeys).toEqual(["LOST"]);
    expect(result.activeKeys).toEqual(["NEW", "IN_PROGRESS"]);
    expect(result.slaOpenKeys).toEqual(["NEW", "IN_PROGRESS"]);
  });

  it("handles multiple terminal converted keys alongside active keys", () => {
    const result = resolveLeadStatusSemantics([
      { key: "ENROLLED", isTerminal: true, metadata: null },
      { key: "REJECTED", isTerminal: true, metadata: { semantic: "lost" } },
      { key: "PROSPECTING", isTerminal: false, metadata: null },
      { key: "NURTURING", isTerminal: false, metadata: null },
    ]);
    expect(result.convertedKeys).toEqual(["ENROLLED"]);
    expect(result.lostKeys).toEqual(["REJECTED"]);
    expect(result.activeKeys).toEqual(["PROSPECTING", "NURTURING"]);
    expect(result.slaOpenKeys).toEqual(["PROSPECTING", "NURTURING"]);
  });
});
