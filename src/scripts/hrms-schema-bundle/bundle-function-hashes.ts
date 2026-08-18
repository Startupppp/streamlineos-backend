export const leaveRejectFunctionHash =
  "07b6c45edd0a09e1a4c3be8a9f8d6022f15500b7cdcce1f152035da1c1509a5e";

const hashes: Record<string, string[]> = {
  enforce_hrms_bundle_operation_transition: ["34a45daaa5a93e4459596293dd5f07e61b57a3313556dde7a0f8e02f025a1665"],
  enforce_hrms_partition_operation_transition: ["744c6c64d4bc5f2123f9cbdc631d114e23a9ae9882bd9e70ade1c61be723ff3c"],
  reject_hrms_append_only_mutation: [
    "760f635c8f130a2212691f5d1317ea602a3ee3c574be1d7303793e6e5be6df42",
    leaveRejectFunctionHash,
  ],
  hrms_modes_valid: ["502ba67a6fa0385bc8236848fd665d3bc9e4b8bb3525e84a5c324ad78660e59a"],
  hrms_profile_modes_json: ["dded28617f64d9ee001941028204504b829169f1cb1ce55df7ba7c8bc690ac80"],
  enforce_hrms_profile_transition: ["68c57e7d6db920e6f87e7179b14286319724248a7782f533b664c267bd1a2b87"],
  verify_hrms_profile_event_coupling: ["9241e4f6168db35fffa5acf42662ee8f7428b12ff5203a403ae37fc12f97691c"],
  enforce_hrms_scope_revision: ["6e0ad9c595f0acf8199952c3609c53ccb0a960aa7ae7f380b136be62e4bd545d"],
  seed_hrms_profile_for_organization: ["0813762becb4e6fad86e1ea321a3c7ec3d02f46b1ed80f5bd8bd0a0ec7c4aab4"],
  verify_hr_workforce_mapping: ["99bb0ced49f5a70c1c44468e27f738b0f33ae7cf1976f4680d14227a708c411d"],
  enforce_hr_workforce_reconciliation_transition: ["50c8c61e85e3f6ad481f89b9c82a056d3161c636675399e439ed60c7f0847346"],
  verify_workforce_org_unit_kinds: ["61708cae1d5ce5455ba3bd29873d9bb9d659740cb2dd868796b4b05ba0f4d9ae"],
  enforce_workforce_period_revision: ["185dfe330a6f08bb7db86130c1f1dc4582869a755aec0eff1819bca5cce8ec6b"],
  lock_worker_reporting_line_tenant: ["0934b8d34dd4228e1188b91d29ecde09a3d7a76d91122e15717095b64bf76ed7"],
  lock_worker_engagement_state_transition: ["5e4e47f8fbe3f78e2745ffb5690dc7523395311e360e3b108df67f8002e4f643"],
  verify_worker_reporting_line_cycles: ["e13f439e17c71ae8831898eb7af74f10bb4e5ce9ae673e56bd196006b311611b"],
  verify_worker_engagement_state_chain: ["3a352ad5010d2a9bb1f33602be744fb78a20f717b17ef1c78ef8e0f2fff6ce33"],
  verify_worker_engagement_state_projection: ["ceaa6759f81d310bf1008f6e2484769c6f32c9400cb30dabf26c8e012c45e495"],
  verify_worker_leave_locator_fact: ["ebbdde6c182cffd019424aa98e1e927b1de0df5c64724f63fa5014038c748205"],
  verify_worker_leave_reversal: ["5082e996f256b192b28a2aee3890fbe1a287853a5b9ebc8b638fcef1bab6ad43"],
  verify_worker_leave_balance_projection: ["7f78fe607b17f9da6fea51056ae24fb237c1d91c1073f1b5d4c0a77ff9a484f1"],
  verify_attendance_locator_fact: ["853f578874cd1c299cb7105bd53d76649f68270171af51e05e367891d9114ce7"],
  verify_attendance_correction: ["bb3645930fc3e49d66a512a6d85520dd1a0e01001e8c6552b27a6fb8fb311001"],
  verify_attendance_correction_link: ["0f9aed63c8eb4bfdd4fae29a817cdfd117a9ce54788de39ce9bc7b3f597d2960"],
  verify_attendance_projection_events: ["8bc6265e95f28bfc6ff2c7bf96d22d81aa227f7c4b668df4c2bcf709d6c51e13"],
  reject_attendance_evidence_mutation: ["3d25ef31dbcdb8e9e8debb8fcf5816407094a750d7372980145b8adb4e8fcdc9"],
  verify_org_unit_parent_cycle: ["9c82aea49f2d7f7a26913fb9b827bef28aabcaf4b8aae02e0be1e35a5bff409d"],
  verify_hr_audit_source_fact: ["902c6687a0377df3bd079da25561e2178b80a31a0a5819989101843f09391403"],
};

export function functionBodyHashes(name: string): string[] {
  const values = hashes[name];
  if (!values) throw new Error(`missing function hash recipe: ${name}`);
  return values;
}
