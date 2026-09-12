import { ackTransitionRefusal } from "./ack-transition";

describe("ackTransitionRefusal", () => {
  it("admits the first acknowledgement of any status", () => {
    expect(ackTransitionRefusal(null, "RECEIVED")).toBeNull();
    expect(ackTransitionRefusal(null, "ACCEPTED")).toBeNull();
    expect(ackTransitionRefusal(null, "REJECTED")).toBeNull();
    expect(ackTransitionRefusal(null, "FAILED")).toBeNull();
  });

  it("admits the payroll side working through an export", () => {
    expect(ackTransitionRefusal("RECEIVED", "ACCEPTED")).toBeNull();
    expect(ackTransitionRefusal("RECEIVED", "REJECTED")).toBeNull();
    expect(ackTransitionRefusal("REJECTED", "ACCEPTED")).toBeNull();
    expect(ackTransitionRefusal("FAILED", "ACCEPTED")).toBeNull();
    expect(ackTransitionRefusal("ACCEPTED", "REJECTED")).toBeNull();
  });

  it("refuses recording the status the export already has", () => {
    expect(ackTransitionRefusal("ACCEPTED", "ACCEPTED")).toMatch(/already acknowledged as ACCEPTED/);
    expect(ackTransitionRefusal("RECEIVED", "RECEIVED")).toMatch(/already acknowledged as RECEIVED/);
  });

  it("refuses withdrawing a settled answer back to RECEIVED", () => {
    expect(ackTransitionRefusal("ACCEPTED", "RECEIVED")).toMatch(/cannot go back to RECEIVED/);
    expect(ackTransitionRefusal("REJECTED", "RECEIVED")).toMatch(/cannot go back to RECEIVED/);
    expect(ackTransitionRefusal("FAILED", "RECEIVED")).toMatch(/cannot go back to RECEIVED/);
  });
});
