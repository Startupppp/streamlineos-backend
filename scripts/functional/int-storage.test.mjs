import { req, mint, check, report, BASE_URL, ORG, USERS } from "./harness.mjs";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

// ===========================================================================
// Storage integration module — src/modules/storage
// Live backend @ http://localhost:1500 with real Cloudflare R2 keys in .env.
//
// ROUTES (method  path  guard / access):
//  StorageController @UseGuards(JwtAuthGuard):
//   1. POST   /storage/upload                      auth-only (no RBAC). multipart "file" + "folder".
//   2. GET    /storage/download                    auth-only. ?url|?key|?expiresIn|?attachment.
//   3. GET    /storage/image                       auth-only + must be an org member. ?key.
//  OnboardingDocumentsController @UseGuards(JwtAuthGuard):
//   4. POST   /onboarding/documents                auth-only. multipart "file" + "type" (enum).
//  StorageKbController @Public():
//   5. GET    /public/kb/:slug/attachments         PUBLIC. ?org (zod min1). signs downloadUrl if cfg.
//  StorageVaultController @UseGuards(JwtAuthGuard):
//   6. GET    /hr/recruitment/candidates/:cid/vault/:did(\d+)   role CEO|HR|ADMIN || owner||platform.
//   7. DELETE /hr/recruitment/candidates/:cid/vault/:did(\d+)   same RBAC.
//
// RBAC model: owner=isOrgOwner -> privileged on vault. member(MEMBER)-> not in vault roles -> 403.
//   storage upload/download/image have NO role/plan gate beyond JwtAuthGuard, so member behaves
//   like owner there (proves auth-only). KB is fully public. No global plan/module guard applies.
//
// NOT-CONFIGURED PATH: every handler short-circuits to 503 when isConfigured() is false. With real
//   R2 keys present isConfigured()=true, so the 503 branch is unreachable at runtime; it is covered
//   structurally (documented) not by a live request.
//
// SAFETY — ONE real external round-trip only: POST /storage/upload a 1x1 PNG under an FN_TEST_ key,
//   fetch its presigned URL via GET /storage/download (local HMAC signing, no S3 network), verify
//   the object exists (HeadObject) and DELETE it (DeleteObjectCommand) directly via the SDK using
//   the same R2 creds so nothing is left in the bucket (no controller delete route exists for
//   /storage/upload). All validation/RBAC tests short-circuit BEFORE any S3 write.
// ===========================================================================

const NX = 999999999;

// shape/value assertion that participates in the harness pass/fail tally
const assert = (name, cond) => check(name, { status: cond ? 1 : 0 }, 1);

// 1x1 transparent PNG (valid magic bytes 89 50 4E 47, > 12 bytes)
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");

async function multipart(path, token, { fields = {}, file } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) {
    fd.append("file", new Blob([file.buf], { type: file.type }), file.name);
  }
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers, body: fd });
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

function r2Client() {
  return new S3Client({
    region: process.env.R2_REGION || "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

const realCalls = [];

async function main() {
  const owner = await mint("owner");
  const member = await mint("member");
  // a role that is NOT in VAULT_ROLES (CEO|HR|ADMIN) and not privileged
  const salesRep = await mint("member", { role: "SALES_REP" });
  // wrong-plan probe (free) — storage has no plan gate, so this must still pass auth, not 402
  const freeMember = await mint("member", { role: "MEMBER", plan: "free" });

  // =========================================================================
  // 1. AUTH — every guarded route, no token -> 401; public route -> not 401
  // =========================================================================
  console.log("\n== AUTH (no token) ==");
  const GUARDED = [
    ["POST", "/storage/upload"],
    ["GET", "/storage/download?key=uploads/1-a.png"],
    ["GET", "/storage/image?key=uploads/1-a.png"],
    ["POST", "/onboarding/documents"],
    ["GET", `/hr/recruitment/candidates/1/vault/2`],
    ["DELETE", `/hr/recruitment/candidates/1/vault/2`],
  ];
  for (const [m, p] of GUARDED) {
    check(`401 ${m} ${p}`, await req(m, p), 401);
  }
  // POST /storage/upload no-token via multipart path too (FileInterceptor still behind guard)
  check("401 POST /storage/upload (multipart, no token)", await multipart("/storage/upload", null, {
    file: { buf: PNG, name: "x.png", type: "image/png" },
  }), 401);
  // public KB route must NOT be 401 even without a token
  {
    const g = await req("GET", `/public/kb/no-such-slug/attachments?org=${ORG}`);
    assert("public KB not 401 without token", g.status !== 401);
    check("public KB unknown slug -> 404", g, 404);
  }

  // =========================================================================
  // 2. RBAC — vault routes gated to CEO|HR|ADMIN||owner; storage is auth-only
  // =========================================================================
  console.log("\n== RBAC ==");
  // member (MEMBER) -> 403 on vault GET/DELETE
  check("403 vault GET member", await req("GET", `/hr/recruitment/candidates/1/vault/2`, { token: member }), 403);
  check("403 vault DELETE member", await req("DELETE", `/hr/recruitment/candidates/1/vault/2`, { token: member }), 403);
  // wrong-role (SALES_REP) -> 403 on vault
  check("403 vault GET wrong-role(SALES_REP)", await req("GET", `/hr/recruitment/candidates/1/vault/2`, { token: salesRep }), 403);
  check("403 vault DELETE wrong-role(SALES_REP)", await req("DELETE", `/hr/recruitment/candidates/1/vault/2`, { token: salesRep }), 403);

  // storage upload/download have NO RBAC -> member/free-plan must reach validation (400), NOT 403/402
  check("storage upload member -> 400 not 403 (auth-only, no file)", await req("POST", "/storage/upload", { token: member }), 400);
  check("storage upload free-plan -> 400 not 402 (no plan gate, no file)", await req("POST", "/storage/upload", { token: freeMember }), 400);
  check("storage download member -> 400 not 403 (auth-only, no params)", await req("GET", "/storage/download", { token: member }), 400);

  // =========================================================================
  // 3. INPUT VALIDATION (all short-circuit BEFORE any S3 write)
  // =========================================================================
  console.log("\n== VALIDATION ==");
  // upload: no file -> 400 (JSON body, no multipart -> @UploadedFile undefined)
  check("upload no file -> 400", await req("POST", "/storage/upload", { token: owner }), 400);
  // upload: disallowed mime type -> 400
  check("upload disallowed type(text/plain) -> 400", await multipart("/storage/upload", owner, {
    fields: { folder: "fn-test" },
    file: { buf: Buffer.from("hello world not an image"), name: "FN_TEST_note.txt", type: "text/plain" },
  }), 400);
  // upload: declared png but bytes mismatch magic signature -> 400
  check("upload magic-byte mismatch -> 400", await multipart("/storage/upload", owner, {
    fields: { folder: "fn-test" },
    file: { buf: Buffer.from("this is definitely not a real png file body"), name: "FN_TEST_fake.png", type: "image/png" },
  }), 400);

  // download: no url & no key -> 400
  check("download no url/key -> 400", await req("GET", "/storage/download", { token: owner }), 400);
  // download: path-traversal key -> 400
  check("download traversal key(..) -> 400", await req("GET", "/storage/download?key=" + encodeURIComponent("../secret.png"), { token: owner }), 400);
  check("download leading-slash key -> 400", await req("GET", "/storage/download?key=" + encodeURIComponent("/etc/passwd"), { token: owner }), 400);

  // image: missing key -> 400; bad key -> 400
  check("image missing key -> 400", await req("GET", "/storage/image", { token: owner }), 400);
  check("image traversal key -> 400", await req("GET", "/storage/image?key=" + encodeURIComponent("..\\win.ini"), { token: owner }), 400);
  // image: valid but non-existent key -> graceful 403(no member) or 404(member,no object), never 500
  {
    const g = await req("GET", "/storage/image?key=" + encodeURIComponent("fn-test/0-missing.png"), { token: owner });
    check("image valid nonexistent key -> 403|404 (graceful)", g, [403, 404]);
  }

  // onboarding: no file -> 400
  check("onboarding no file -> 400", await req("POST", "/onboarding/documents", { token: owner }), 400);
  // onboarding: file present but invalid type enum -> 400 (rejected BEFORE upload)
  check("onboarding invalid type enum -> 400", await multipart("/onboarding/documents", owner, {
    fields: { type: "BOGUS_TYPE" },
    file: { buf: PNG, name: "FN_TEST_doc.png", type: "image/png" },
  }), 400);

  // KB: missing required org query -> 400 (zod)
  check("public KB missing ?org -> 400", await req("GET", "/public/kb/some-slug/attachments"), 400);

  // vault: ParseIntPipe / route-regex
  check("vault non-numeric candidateId -> 400 (ParseIntPipe)", await req("GET", "/hr/recruitment/candidates/abc/vault/2", { token: owner }), 400);
  check("vault non-numeric documentId -> 404 (route regex no match)", await req("GET", "/hr/recruitment/candidates/1/vault/abc", { token: owner }), 404);
  // vault owner (privileged) on non-existent doc -> 404 (proves handler wired, no 500)
  check("vault GET owner nonexistent -> 404", await req("GET", `/hr/recruitment/candidates/${NX}/vault/${NX}`, { token: owner }), 404);
  check("vault DELETE owner nonexistent -> 404", await req("DELETE", `/hr/recruitment/candidates/${NX}/vault/${NX}`, { token: owner }), 404);

  // =========================================================================
  // 4. ONE REAL SAFE ROUND-TRIP: upload -> presign -> head -> delete cleanup
  // =========================================================================
  console.log("\n== REAL CALL (FN_TEST_ upload + cleanup) ==");
  let uploadedKey = null;
  const up = await multipart("/storage/upload", owner, {
    fields: { folder: "fn-test" },
    file: { buf: PNG, name: "FN_TEST_probe.png", type: "image/png" },
  });
  const upOk = check("REAL upload -> 200|201", up, [200, 201]);
  if (upOk && up.body && typeof up.body === "object") {
    realCalls.push(`PUT object to R2 via POST /storage/upload (key=${up.body.key})`);
    uploadedKey = up.body.key;
    // NOTE: StorageService sanitizes filename via /[^a-zA-Z0-9.-]/g -> "-", so FN_TEST_probe -> FN-TEST-probe
    assert("upload body has key:string (FN-TEST marker)", typeof up.body.key === "string" && up.body.key.includes("FN-TEST-probe"));
    assert("upload body has url:string", typeof up.body.url === "string" && up.body.url.length > 0);
    assert("upload body size === png length", up.body.size === PNG.length);
    assert("upload body mimeType image/png", up.body.mimeType === "image/png");
    assert("upload key under fn-test/ folder", typeof up.body.key === "string" && up.body.key.startsWith("fn-test/"));

    // presigned URL via the download route (local HMAC sign, no network)
    const dl = await req("GET", "/storage/download?key=" + encodeURIComponent(uploadedKey), { token: owner });
    const dlOk = check("REAL download presigned -> 200", dl, 200);
    if (dlOk && dl.body && typeof dl.body === "object") {
      realCalls.push(`GET presigned URL via GET /storage/download?key=${uploadedKey}`);
      const u = dl.body.url || "";
      assert("presigned url is http(s)", /^https?:\/\//.test(u));
      assert("presigned url has X-Amz-Signature", /X-Amz-Signature=/.test(u));
      assert("presigned url has X-Amz-Expires", /X-Amz-Expires=/.test(u));
      assert("presigned url has X-Amz-Algorithm", /X-Amz-Algorithm=/.test(u));
      assert("presigned url references uploaded key", u.includes("FN-TEST-probe") || u.includes("fn-test"));
    }
  }

  // cleanup — verify object exists then delete it directly so the bucket is left clean
  if (uploadedKey) {
    const c = r2Client();
    const bucket = process.env.R2_BUCKET_NAME;
    let existed = false;
    try {
      await c.send(new HeadObjectCommand({ Bucket: bucket, Key: uploadedKey }));
      existed = true;
      realCalls.push(`HeadObject (verify exists) on R2 key ${uploadedKey}`);
    } catch (e) {
      // object may have been created; treat head failure as non-fatal but record
      console.log("  NOTE: HeadObject failed: " + (e?.name || e?.message));
    }
    assert("REAL object exists in bucket after upload", existed);
    try {
      await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: uploadedKey }));
      realCalls.push(`DeleteObject (cleanup) on R2 key ${uploadedKey}`);
      console.log("  CLEANUP: deleted " + uploadedKey);
    } catch (e) {
      console.log("  WARN: cleanup delete failed for " + uploadedKey + ": " + (e?.name || e?.message));
    }
    // confirm gone
    let gone = false;
    try {
      await c.send(new HeadObjectCommand({ Bucket: bucket, Key: uploadedKey }));
    } catch {
      gone = true;
    }
    assert("REAL object removed from bucket after cleanup", gone);
  }

  console.log("\nREAL CALLS MADE:");
  for (const rc of realCalls) console.log("  - " + rc);

  const green = report("storage");
  process.exit(green ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
