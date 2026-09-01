export {
  SLO_OWNERS,
  ALERT_RUNBOOK,
  FAILURE_RUNBOOK,
  type SloOwner,
  type SloSubjectKind,
  type SloIndicator,
  type ServiceLevelObjective,
} from "./slo-types";
export { MODULE_SLOS, MODULE_SLO_OWNERSHIP, ownerForModule } from "./slo-modules";
export { QUEUE_SLOS, QUEUE_SUBJECTS } from "./slo-queues";

import { MODULE_SLOS } from "./slo-modules";
import { QUEUE_SLOS } from "./slo-queues";
import type { ServiceLevelObjective } from "./slo-types";

export const SLO_CATALOGUE: readonly ServiceLevelObjective[] = [
  ...MODULE_SLOS,
  ...QUEUE_SLOS,
];
