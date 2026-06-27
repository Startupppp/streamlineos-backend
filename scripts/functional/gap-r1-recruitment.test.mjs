import { mint, req, check, report } from "./harness.mjs";

const owner = await mint("owner");
const member = await mint("member");
const hrManager = await mint("hrManager");

const UNKNOWN_ID = 999999999;
const VALID_ROLLOUT = { templateIds: [1], variables: {}, sendEmail: false };

check(
  "no-token POST candidates/:id/ai-score -> 401",
  await req("POST", `/hr/recruitment/candidates/${UNKNOWN_ID}/ai-score`, { body: {} }),
  401,
);
check(
  "member POST candidates/:id/ai-score -> 403 (HR/CEO/ADMIN gate)",
  await req("POST", `/hr/recruitment/candidates/${UNKNOWN_ID}/ai-score`, { token: member, body: {} }),
  403,
);
check(
  "owner POST candidates/abc/ai-score -> 400 (non-numeric id)",
  await req("POST", "/hr/recruitment/candidates/abc/ai-score", { token: owner, body: {} }),
  400,
);

check(
  "no-token POST candidates/:id/composite-score -> 401",
  await req("POST", `/hr/recruitment/candidates/${UNKNOWN_ID}/composite-score`, { body: {} }),
  401,
);
check(
  "member POST candidates/:id/composite-score -> 403",
  await req("POST", `/hr/recruitment/candidates/${UNKNOWN_ID}/composite-score`, { token: member, body: {} }),
  403,
);
check(
  "owner POST candidates/abc/composite-score -> 400 (non-numeric id)",
  await req("POST", "/hr/recruitment/candidates/abc/composite-score", { token: owner, body: {} }),
  400,
);

check(
  "no-token POST candidates/:id/resume-parse -> 401",
  await req("POST", `/hr/recruitment/candidates/${UNKNOWN_ID}/resume-parse`, { body: {} }),
  401,
);
check(
  "member POST candidates/:id/resume-parse -> 403 (HR_MANAGER gate)",
  await req("POST", `/hr/recruitment/candidates/${UNKNOWN_ID}/resume-parse`, { token: member, body: {} }),
  403,
);
check(
  "owner POST candidates/abc/resume-parse -> 400 (non-numeric id)",
  await req("POST", "/hr/recruitment/candidates/abc/resume-parse", { token: owner, body: {} }),
  400,
);

check(
  "no-token GET candidates/:id/rollout-documents -> 401",
  await req("GET", `/hr/recruitment/candidates/${UNKNOWN_ID}/rollout-documents`),
  401,
);
check(
  "owner GET candidates/abc/rollout-documents -> 400 (non-numeric id)",
  await req("GET", "/hr/recruitment/candidates/abc/rollout-documents", { token: owner }),
  400,
);
check(
  "owner GET candidates/:unknown/rollout-documents -> 404 (candidate missing)",
  await req("GET", `/hr/recruitment/candidates/${UNKNOWN_ID}/rollout-documents`, { token: owner }),
  404,
);
check(
  "no-token POST candidates/:id/rollout-documents -> 401",
  await req("POST", `/hr/recruitment/candidates/${UNKNOWN_ID}/rollout-documents`, { body: VALID_ROLLOUT }),
  401,
);
check(
  "member POST candidates/:id/rollout-documents -> 403 (HR_MANAGER gate)",
  await req("POST", `/hr/recruitment/candidates/${UNKNOWN_ID}/rollout-documents`, { token: member, body: VALID_ROLLOUT }),
  403,
);
check(
  "hrManager POST candidates/:id/rollout-documents (empty body) -> 400 (templateIds required)",
  await req("POST", `/hr/recruitment/candidates/${UNKNOWN_ID}/rollout-documents`, { token: hrManager, body: {} }),
  400,
);

check(
  "no-token GET recruitment/messages -> 401",
  await req("GET", "/hr/recruitment/messages"),
  401,
);
check(
  "owner GET recruitment/messages -> 200 (safe read)",
  await req("GET", "/hr/recruitment/messages", { token: owner }),
  200,
);
check(
  "owner GET recruitment/messages?limit=0 -> 400 (invalid query)",
  await req("GET", "/hr/recruitment/messages?limit=0", { token: owner }),
  400,
);
check(
  "no-token POST recruitment/messages -> 401",
  await req("POST", "/hr/recruitment/messages", { body: {} }),
  401,
);
check(
  "owner POST recruitment/messages (empty body) -> 400 (validation)",
  await req("POST", "/hr/recruitment/messages", { token: owner, body: {} }),
  400,
);

check(
  "no-token GET recruitment/interviews -> 401",
  await req("GET", "/hr/recruitment/interviews"),
  401,
);
check(
  "owner GET recruitment/interviews -> 200 (safe read)",
  await req("GET", "/hr/recruitment/interviews", { token: owner }),
  200,
);

check(
  "no-token DELETE recruitment/interviews/:id -> 401",
  await req("DELETE", `/hr/recruitment/interviews/${UNKNOWN_ID}`),
  401,
);
check(
  "owner DELETE recruitment/interviews/abc -> 400 (non-numeric id)",
  await req("DELETE", "/hr/recruitment/interviews/abc", { token: owner }),
  400,
);

check(
  "no-token GET recruitment/interviews/:id/scorecard -> 401",
  await req("GET", `/hr/recruitment/interviews/${UNKNOWN_ID}/scorecard`),
  401,
);
check(
  "owner GET recruitment/interviews/abc/scorecard -> 400 (non-numeric id)",
  await req("GET", "/hr/recruitment/interviews/abc/scorecard", { token: owner }),
  400,
);
check(
  "owner GET recruitment/interviews/:unknown/scorecard -> 404 (interview missing)",
  await req("GET", `/hr/recruitment/interviews/${UNKNOWN_ID}/scorecard`, { token: owner }),
  404,
);

process.exit(report("gap-r1-recruitment") ? 0 : 1);
