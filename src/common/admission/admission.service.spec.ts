import type { AdmissionConfig } from "./admission.config";
import { AdmissionService } from "./admission.service";

const BASE_CONFIG: AdmissionConfig = {
  maxConcurrent: 10,
  maxQueueDepth: 400,
  maxExecutionMs: 5_000,
  maxBodyBytes: 3_145_728,
  orgMaxConcurrent: 3,
  reservedFraction: 0.2,
  enabled: true,
};

function makeSvc(overrides: Partial<AdmissionConfig> = {}): AdmissionService {
  return new AdmissionService({ ...BASE_CONFIG, ...overrides });
}

function fillTo(svc: AdmissionService, count: number): void {
  for (let i = 0; i < count; i++) {
    const d = svc.tryAdmit("authentication", `fill-org-${i}`);
    if (!d.admitted) throw new Error(`Could not fill slot ${i}: capacity limit reached unexpectedly`);
  }
}

describe("AdmissionService — shed order", () => {
  it("admits prefetch at 0 in-flight", () => {
    const svc = makeSvc();
    expect(svc.tryAdmit("prefetch", "org-a")).toMatchObject({ admitted: true });
  });

  it("refuses prefetch at threshold=1 while analytics-refresh still admits", () => {
    const svc = makeSvc();
    fillTo(svc, 1);
    expect(svc.snapshot().inFlight).toBe(1);
    expect(svc.tryAdmit("prefetch", "org-b")).toMatchObject({ admitted: false });
    const svc2 = makeSvc();
    fillTo(svc2, 1);
    expect(svc2.tryAdmit("analytics-refresh", "org-b")).toMatchObject({ admitted: true });
  });

  it("refuses analytics-refresh at threshold=2 while ai-enrichment still admits", () => {
    const svc = makeSvc();
    fillTo(svc, 2);
    expect(svc.tryAdmit("analytics-refresh", "org-b")).toMatchObject({ admitted: false });
    const svc2 = makeSvc();
    fillTo(svc2, 2);
    expect(svc2.tryAdmit("ai-enrichment", "org-b")).toMatchObject({ admitted: true });
  });

  it("refuses ai-enrichment at threshold=4 while search-freshness still admits", () => {
    const svc = makeSvc();
    fillTo(svc, 4);
    expect(svc.tryAdmit("ai-enrichment", "org-b")).toMatchObject({ admitted: false });
    const svc2 = makeSvc();
    fillTo(svc2, 4);
    expect(svc2.tryAdmit("search-freshness", "org-b")).toMatchObject({ admitted: true });
  });

  it("refuses search-freshness at threshold=5 while non-mandatory-notification still admits", () => {
    const svc = makeSvc();
    fillTo(svc, 5);
    expect(svc.tryAdmit("search-freshness", "org-b")).toMatchObject({ admitted: false });
    const svc2 = makeSvc();
    fillTo(svc2, 5);
    expect(svc2.tryAdmit("non-mandatory-notification", "org-b")).toMatchObject({ admitted: true });
  });

  it("refuses non-mandatory-notification at threshold=6 while ordinary-write still admits", () => {
    const svc = makeSvc();
    fillTo(svc, 6);
    expect(svc.tryAdmit("non-mandatory-notification", "org-b")).toMatchObject({ admitted: false });
    const svc2 = makeSvc();
    fillTo(svc2, 6);
    expect(svc2.tryAdmit("ordinary-write", "org-b")).toMatchObject({ admitted: true });
  });

  it("refuses ordinary-write at threshold=8 while reserved authentication still admits", () => {
    const svc = makeSvc();
    fillTo(svc, 8);
    expect(svc.tryAdmit("ordinary-write", "org-b")).toMatchObject({ admitted: false });
    const svc2 = makeSvc();
    fillTo(svc2, 8);
    expect(svc2.tryAdmit("authentication", "org-b")).toMatchObject({ admitted: true });
  });
});

describe("AdmissionService — reserved classes survive full sheddable saturation", () => {
  const RESERVED_CLASSES = [
    "authentication",
    "authorization-revocation",
    "ownership",
    "billing-ledger",
    "payroll-posting",
    "audit",
    "mandatory-security-delivery",
  ] as const;

  it("admits every reserved class at full sheddable saturation (inFlight=8)", () => {
    for (const rc of RESERVED_CLASSES) {
      const svc = makeSvc();
      fillTo(svc, 8);
      expect(svc.tryAdmit("ordinary-write", "org-b")).toMatchObject({ admitted: false });
      expect(svc.tryAdmit(rc, "org-b")).toMatchObject({ admitted: true });
    }
  });

  it("refuses reserved class only when maxConcurrent is fully saturated", () => {
    const svc = makeSvc();
    fillTo(svc, 9);
    expect(svc.tryAdmit("authentication", "org-b")).toMatchObject({ admitted: true });
    svc.tryAdmit("authentication", "org-b");
    expect(svc.snapshot().inFlight).toBe(10);
    expect(svc.tryAdmit("authentication", "org-b")).toMatchObject({ admitted: false });
  });

  it("refuses even a reserved class once the absolute queue-depth ceiling is reached", () => {
    const svc = makeSvc({ maxQueueDepth: 4, maxConcurrent: 100 });
    fillTo(svc, 4);

    expect(svc.snapshot().inFlight).toBe(4);
    expect(svc.tryAdmit("authentication", "org-b")).toMatchObject({ admitted: false });
    expect(svc.tryAdmit("ordinary-write", "org-b")).toMatchObject({ admitted: false });
  });

  it("readmits at the queue-depth ceiling once a slot is released", () => {
    const svc = makeSvc({ maxQueueDepth: 4, maxConcurrent: 100 });
    fillTo(svc, 4);
    expect(svc.tryAdmit("authentication", "org-b")).toMatchObject({ admitted: false });

    svc.release("fill-org-0");

    expect(svc.tryAdmit("authentication", "org-b")).toMatchObject({ admitted: true });
  });

  it("refusal includes retryAfterSeconds > 0", () => {
    const svc = makeSvc();
    fillTo(svc, 10);
    const d = svc.tryAdmit("authentication", "org-b");
    expect(d.admitted).toBe(false);
    if (!d.admitted) expect(d.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("AdmissionService — per-org bound", () => {
  it("refuses a noisy org without refusing another org", () => {
    const svc = makeSvc();
    svc.tryAdmit("ordinary-write", "noisy");
    svc.tryAdmit("ordinary-write", "noisy");
    svc.tryAdmit("ordinary-write", "noisy");
    expect(svc.tryAdmit("ordinary-write", "noisy")).toMatchObject({ admitted: false });
    expect(svc.tryAdmit("ordinary-write", "quiet")).toMatchObject({ admitted: true });
  });

  it("does not apply per-org cap to reserved classes", () => {
    const svc = makeSvc();
    svc.tryAdmit("ordinary-write", "noisy");
    svc.tryAdmit("ordinary-write", "noisy");
    svc.tryAdmit("ordinary-write", "noisy");
    expect(svc.tryAdmit("authentication", "noisy")).toMatchObject({ admitted: true });
  });
});

describe("AdmissionService — in-flight accounting and map pruning", () => {
  it("increments on admit and returns to zero after release", () => {
    const svc = makeSvc();
    svc.tryAdmit("ordinary-write", "org-a");
    expect(svc.snapshot().inFlight).toBe(1);
    svc.release("org-a");
    expect(svc.snapshot().inFlight).toBe(0);
  });

  it("prunes the org map entry when count reaches zero on release", () => {
    const svc = makeSvc();
    svc.tryAdmit("ordinary-write", "org-prune");
    expect(svc.snapshot().orgMapSize).toBe(1);
    svc.release("org-prune");
    expect(svc.snapshot().orgMapSize).toBe(0);
  });

  it("release on an unknown orgId does not throw", () => {
    const svc = makeSvc();
    expect(() => svc.release("unknown-org")).not.toThrow();
  });

  it("release never pushes inFlight below zero", () => {
    const svc = makeSvc();
    svc.release("org-a");
    expect(svc.snapshot().inFlight).toBe(0);
  });

  it("tracks multiple orgs independently and pruning keeps size exact", () => {
    const svc = makeSvc();
    svc.tryAdmit("ordinary-write", "org-1");
    svc.tryAdmit("ordinary-write", "org-2");
    expect(svc.snapshot().orgMapSize).toBe(2);
    svc.release("org-1");
    expect(svc.snapshot().orgMapSize).toBe(1);
    svc.release("org-2");
    expect(svc.snapshot().orgMapSize).toBe(0);
  });
});

describe("AdmissionService — disabled mode", () => {
  it("admits everything when enabled=false, including at full saturation", () => {
    const svc = makeSvc({ enabled: false });
    for (let i = 0; i < 1000; i++) {
      expect(svc.tryAdmit("prefetch", "org-a")).toMatchObject({ admitted: true });
    }
  });
});
