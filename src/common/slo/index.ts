import { MODULE_SLOS } from "./slo-modules";
import { QUEUE_SLOS } from "./slo-queues";
import { KB_SLOS } from "./slo-kb-indexing";
import { KB_ASK_SLOS } from "./slo-kb-ask";
import { KB_SEARCH_SLOS } from "./slo-kb-search";
import type { ServiceLevelObjective } from "./slo-types";

export { SLO_OWNERS } from "./slo-types";
export { MODULE_SLOS } from "./slo-modules";
export { QUEUE_SLOS, QUEUE_SUBJECTS } from "./slo-queues";
export {
  KB_SLOS,
  KB_INDEXING_SLO,
  KB_INDEXING_SPAN,
  KB_INDEXING_MIN_FAULTS,
  KB_INDEXING_FAULT_OUTCOMES,
  KB_INDEXING_MAX_FAULT_RATIO,
} from "./slo-kb-indexing";
export {
  KB_ASK_SLO,
  KB_ASK_SLOS,
  KB_ASK_SPAN,
  KB_ASK_MIN_FAULTS,
  KB_ASK_FAULT_OUTCOMES,
  KB_ASK_MAX_FAULT_RATIO,
} from "./slo-kb-ask";
export {
  KB_SEARCH_SLO,
  KB_SEARCH_SLOS,
  KB_SEARCH_SPAN,
  KB_SEARCH_MIN_FAULTS,
  KB_SEARCH_MIN_DENIALS,
  KB_SEARCH_MIN_NOT_FOUND,
  KB_SEARCH_FAULT_OUTCOMES,
  KB_SEARCH_MAX_FAULT_RATIO,
  KB_SEARCH_MAX_DENIED_RATIO,
  KB_SEARCH_MAX_NOT_FOUND_RATIO,
} from "./slo-kb-search";

export const SLO_CATALOGUE: readonly ServiceLevelObjective[] = [
  ...MODULE_SLOS,
  ...QUEUE_SLOS,
  ...KB_SLOS,
  ...KB_ASK_SLOS,
  ...KB_SEARCH_SLOS,
];
