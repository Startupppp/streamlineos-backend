# Domain migration checklist (strangler-fig)

Kernel + auth bridge: done (Plan A) — config, DB module, exception filter, Zod pipe, JWT auth
(HS256-pinned), CASL ability + module guards, cache/pagination/audit, and the /me proving endpoint.

| Domain | Routes | Ported | Verified | Cutover (web routes deleted) |
|--------|-------:|:------:|:--------:|:----------------------------:|
| CRM Leads (pilot) | ~31 | no | no | no |
| remaining ~45 domains | - | no | no | no |
