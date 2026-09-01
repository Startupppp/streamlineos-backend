import { MODULE_SLOS } from "./slo-modules";
import { QUEUE_SLOS } from "./slo-queues";
import type { ServiceLevelObjective } from "./slo-types";

export { SLO_OWNERS } from "./slo-types";
export { MODULE_SLOS } from "./slo-modules";
export { QUEUE_SLOS, QUEUE_SUBJECTS } from "./slo-queues";

export const SLO_CATALOGUE: readonly ServiceLevelObjective[] = [
  ...MODULE_SLOS,
  ...QUEUE_SLOS,
];
