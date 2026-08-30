import { BadRequestException } from "@nestjs/common";
import { assertNotAlreadyOnAWave, decideWaveJoin, type OpenWave } from "../waveless";

function wave(overrides: Partial<OpenWave> & { id: number }): OpenWave {
  return {
    warehouseId: 1,
    status: "PENDING",
    lineCount: 10,
    linesPicked: 0,
    ...overrides,
  };
}

const BASE = { maxLines: 50, warehouseId: 1, newLineCount: 3 };

describe("NEO-14 - joining an open wave", () => {
  it("refuses when the setting is off, whatever else is true", () => {
    // Off is the default and the safe one: a new order gets a new wave, which is
    // what happened before this existed.
    const decision = decideWaveJoin({
      ...BASE,
      wavelessPicking: false,
      openWaves: [wave({ id: 1 })],
    });
    expect(decision).toEqual({ join: false, waveId: null, reason: "Waveless picking is switched off" });
  });

  it("joins the fullest open wave in the same warehouse", () => {
    // Fullest first, so waves are finished rather than all grown at once: six
    // half-full waves are six walks; one full wave and five empty ones is one.
    const decision = decideWaveJoin({
      ...BASE,
      wavelessPicking: true,
      openWaves: [wave({ id: 1, lineCount: 5 }), wave({ id: 2, lineCount: 20 })],
    });
    expect(decision.join).toBe(true);
    expect(decision.waveId).toBe(2);
  });

  it("will not join a wave in another warehouse", () => {
    const decision = decideWaveJoin({
      ...BASE,
      wavelessPicking: true,
      openWaves: [wave({ id: 1, warehouseId: 2 })],
    });
    expect(decision.join).toBe(false);
  });

  it("will not join a wave a picker has already started", () => {
    // Once somebody has confirmed a line they are walking a plan. Adding to it
    // behind them is at best a longer walk and at worst a bin they have passed.
    const started = decideWaveJoin({
      ...BASE,
      wavelessPicking: true,
      openWaves: [wave({ id: 1, linesPicked: 1 })],
    });
    expect(started.join).toBe(false);

    const inProgress = decideWaveJoin({
      ...BASE,
      wavelessPicking: true,
      openWaves: [wave({ id: 1, status: "IN_PROGRESS" })],
    });
    expect(inProgress.join).toBe(false);
  });

  it("will not push a wave past the cap", () => {
    // A wave that grows without bound is a picker who never finishes.
    const decision = decideWaveJoin({
      ...BASE,
      wavelessPicking: true,
      maxLines: 12,
      newLineCount: 3,
      openWaves: [wave({ id: 1, lineCount: 10 })],
    });
    expect(decision.join).toBe(false);
    expect(decision.reason).toMatch(/no open wave/i);
  });

  it("refuses to put the same order line on a wave twice", () => {
    // The reservation already stands against the order line; a second pick line
    // would put the same promise on the floor twice.
    expect(() => assertNotAlreadyOnAWave(7, new Set([7]))).toThrow(BadRequestException);
    expect(() => assertNotAlreadyOnAWave(7, new Set([8]))).not.toThrow();
  });
});
