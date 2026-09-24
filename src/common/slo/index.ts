import { MODULE_SLOS } from "./slo-modules";
import { QUEUE_SLOS } from "./slo-queues";
import { KB_SLOS } from "./slo-kb-indexing";
import { KB_ASK_SLOS } from "./slo-kb-ask";
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
export {
  KB_ASK_SLOS,
  KB_ASK_SLO,
  KB_ASK_SPAN,
  KB_ASK_FAULT_OUTCOMES,
  KB_ASK_MAX_FAULT_RATIO,
  KB_ASK_MIN_FAULTS,
} from "./slo-kb-ask";

export const SLO_CATALOGUE: readonly ServiceLevelObjective[] = [
  ...MODULE_SLOS,
  ...QUEUE_SLOS,
  ...KB_SLOS,
  ...KB_ASK_SLOS,
];
