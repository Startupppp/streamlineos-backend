export default [
  {
    key: "modules/build/incidents/incidents.controller.ts#addDecision",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/incidents/:incidentId/decisions. addDecision calls assertProjectAccess(projectId) then loadIncident(orgId, projectId, incidentId) — the same helper proven elsewhere in this file to bind id+orgId+projectId together, 404 on mismatch — before inserting the decision row, which is itself scoped to the now-confirmed incidentId+orgId.",
    blastRadius: "None: a foreign incidentId 404s before any decision row is written.",
    evidence: [
      { file: "src/modules/build/incidents/incidents.service.ts", line: 365, anchor: /await assertProjectAccess\(this\.db, this\.access, u, projectId\);/, note: "project-membership gate" },
      { file: "src/modules/build/incidents/incidents.service.ts", line: 366, anchor: /await this\.loadIncident\(u\.orgId, projectId, incidentId\);/, note: "binds incidentId to projectId via loadIncident before writing" },
    ],
  },
  {
    key: "modules/build/incidents/incidents.controller.ts#addFollowUpAction",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/incidents/:incidentId/follow-ups. Same binding shape as addDecision: assertProjectAccess(projectId) then loadIncident(orgId, projectId, incidentId) before inserting the follow-up-action row.",
    blastRadius: "None: a foreign incidentId 404s before any follow-up action row is written.",
    evidence: [
      { file: "src/modules/build/incidents/incidents.service.ts", line: 430, anchor: /await assertProjectAccess\(this\.db, this\.access, u, projectId\);/, note: "project-membership gate" },
      { file: "src/modules/build/incidents/incidents.service.ts", line: 431, anchor: /await this\.loadIncident\(u\.orgId, projectId, incidentId\);/, note: "binds incidentId to projectId via loadIncident before writing" },
    ],
  },
  {
    key: "modules/build/incidents/incidents.controller.ts#updateFollowUpAction",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/incidents/:incidentId/follow-ups/:followUpActionId. assertProjectAccess(projectId) then loadIncident(orgId, projectId, incidentId) bind the parent incident to this project; the UPDATE's own WHERE independently re-binds id=followUpActionId AND orgId AND incidentId, so a foreign followUpActionId (even one belonging to a different incident in the same org) 404s rather than matching.",
    blastRadius: "None: a foreign incidentId 404s at loadIncident, and a foreign followUpActionId 404s at the UPDATE's own WHERE.",
    evidence: [
      { file: "src/modules/build/incidents/incidents.service.ts", line: 430, anchor: /await assertProjectAccess\(this\.db, this\.access, u, projectId\);/, note: "project-membership gate" },
      { file: "src/modules/build/incidents/incidents.service.ts", line: 431, anchor: /await this\.loadIncident\(u\.orgId, projectId, incidentId\);/, note: "binds incidentId to projectId via loadIncident before updating" },
      { file: "src/modules/build/incidents/incidents.service.ts", line: 447, anchor: /eq\(incidentFollowUpActions\.incidentId, incidentId\),/, note: "UPDATE WHERE independently re-binds id+orgId+incidentId" },
    ],
  },
];
