import { CELL_SHARE } from "../envelope-profile.mjs";

export const RUN_CONDITIONS = {
  cacheMix: {
    coldFraction: 0.2,
    warmFraction: 0.8,
    note: "Cold means a first touch of a tenant's working set in this run; the driver issues the cold fraction against organizations it has not read yet.",
  },
  payload: {
    listPageSize: 50,
    note: "The declared page size for list surfaces. Larger pages are a different measurement, not a harder one.",
  },
  poolPressure: {
    note: "Concurrency is the pool-pressure dimension. Each worker holds one connection while its statement runs, so p95 includes pool wait once concurrency exceeds the pool size.",
  },
  tenantSizes: {
    note: "Driven against the largest organization in the database, which is the 100,000-member fixture when seed:envelope has run. A small tenant measures a different plan.",
  },
  geography: {
    value: "not-declared",
    note: "The driver runs on one machine against Neon in ap-southeast-1. That is not the PRD's reference geography, and no result here may be read as a same-region figure.",
  },
  device: {
    value: "not-applicable",
    note: "No browser is involved, so device-bound objectives are NOT DRIVEN rather than estimated.",
  },
  network: {
    value: "operator-internet-to-neon",
    note: "Every millisecond below includes a round trip to a managed database over the public internet. A colocated deployment would measure lower and this run cannot say by how much.",
  },
};

export const DEFAULT_SHAPE = {
  concurrency: 16,
  durationMs: 30_000,
  burstMultiplier: 2,
  burstDurationMs: 10_000,
  warmupMs: 3_000,
};

export const TARGET_RATES = {
  sustainedRps: CELL_SHARE.sustainedRps,
  burstRps: CELL_SHARE.burstRps,
  note: "Per-cell share of the PRD envelope. A single machine driving a managed database cannot reach these; the runner reports achieved against target as a ratio and never prints the target as though it were achieved.",
};

export function describeShape(shape) {
  return (
    `concurrency=${shape.concurrency} duration=${shape.durationMs}ms` +
    ` warmup=${shape.warmupMs}ms burst=${shape.burstMultiplier}x for ${shape.burstDurationMs}ms`
  );
}
