import { MODULE_SLOS } from "./slo-modules";
import { QUEUE_SLOS } from "./slo-queues";
import { KB_SLOS } from "./slo-kb-indexing";
import type { ServiceLevelObjective } from "./slo-types";

export { SLO_OWNERS } from "./slo-types";
export { MODULE_SLOS } from "./slo-modules";
export { QUEUE_SLOS, QUEUE_SUBJECTS } from "./slo-queues";
export {
  KB_SLOS,
  KB_INDEXING_SLO,
  KB_INDEXING_SPAN,
  KB_INDEXING_FAULT_OUTCOMES,
  KB_INDEXING_MAX_FAULT_RATIO,
  KB_INDEXING_MIN_FAULTS,
} from "./slo-kb-indexing";

export const SLO_CATALOGUE: readonly ServiceLevelObjective[] = [
  ...MODULE_SLOS,
  ...QUEUE_SLOS,
  ...KB_SLOS,
];
