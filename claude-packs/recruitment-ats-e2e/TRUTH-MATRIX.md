# ATS Truth Matrix

This matrix tracks the truth of the system vs. the audit report.

| Ticket ID | Feature | Status | Implementation File | Verification File |
| :--- | :--- | :--- | :--- | :--- |
| `ATS-CORE-002` | Requisition Headcount Link | Verified | `recruitment-requisitions.service.ts` | `requisition-headcount.spec.ts` |
| `ATS-CORE-003` | Job Creation From Req | Verified | `recruitment-requisitions.service.ts` | `recruitment-requisitions.service.spec.ts` |
| `ATS-CORE-005` | Apply Flow / Consent | Verified | `careers.service.ts` / `recruitment-outbox-consumer.ts` | `src/modules/career/careers-tenant-isolation.spec.ts` |
| `ATS-CORE-008` | Seeded Golden Path | Pending | | |
| `ATS-WH-001` | Webhook Dispatch | Pending | | |
| `ATS-WH-004` | Durable Webhook Dispatch | Pending | | |
| `ATS-R2-001` | Resume Upload | Verified | `recruitment-candidate-documents.controller.ts` | `src/modules/hr/recruitment/__tests__/recruitment-candidate-documents.spec.ts` |
