import { isRdsIamAuthEnabled, rdsRegionFor } from "../../db/rds-iam-auth.ts";

export function resolveScriptDbTarget(url, env = process.env) {
  if (!url) return { mode: "unset", reason: "DATABASE_URL is not set" };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { mode: "unparseable", reason: "DATABASE_URL is not a parseable URL" };
  }

  const host = parsed.hostname;
  const port = Number(parsed.port || 5432);
  const username = decodeURIComponent(parsed.username || "");
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));

  if (!isRdsIamAuthEnabled(env)) return { mode: "url", host, port, username, database };

  const region = rdsRegionFor(host, env);
  if (!region)
    return {
      mode: "iam-unresolved",
      reason: `DB_IAM_AUTH is enabled but no region could be resolved from host '${host}' and AWS_REGION is unset`,
      host,
      port,
      username,
      database,
    };

  if (!username)
    return {
      mode: "iam-unresolved",
      reason: "DB_IAM_AUTH is enabled but DATABASE_URL carries no username to sign a token for",
      host,
      port,
      username,
      database,
      region,
    };

  return { mode: "iam", host, port, username, database, region };
}

export async function createScriptSql(options = {}) {
  const env = options.env ?? process.env;
  const url = options.url ?? env.DATABASE_URL;
  const target = resolveScriptDbTarget(url, env);

  if (target.mode === "unset" || target.mode === "unparseable" || target.mode === "iam-unresolved")
    throw new Error(target.reason);

  const { default: postgres } = await import("postgres");
  const connection = { prepare: false, max: 1, ...(options.connection ?? {}) };

  if (target.mode === "url") return postgres(url, connection);

  const { createRdsIamPasswordProvider } = await import("../../db/rds-iam-auth.ts");
  const password = await createRdsIamPasswordProvider({
    host: target.host,
    port: target.port,
    username: target.username,
    region: target.region,
  })();

  return postgres({
    host: target.host,
    port: target.port,
    username: target.username,
    password,
    database: target.database,
    ssl: options.ssl ?? "require",
    ...connection,
  });
}

export function runScriptSqlClientSelfTest(label) {
  const RDS = "postgresql://streamline_admin@streamlineos-instance-1.c94aokgu6g21.ap-south-1.rds.amazonaws.com:5432/streamlineos?sslmode=require";
  const LOCAL = "postgresql://u:p@127.0.0.1:5432/app";

  const cases = [
    ["an unset url is refused rather than treated as local", resolveScriptDbTarget(undefined, {}).mode, "unset"],
    ["an empty url is refused", resolveScriptDbTarget("", {}).mode, "unset"],
    ["a malformed url is refused", resolveScriptDbTarget("not-a-url", {}).mode, "unparseable"],
    ["without DB_IAM_AUTH an rds url stays on the plain url path", resolveScriptDbTarget(RDS, {}).mode, "url"],
    ["DB_IAM_AUTH=false does not enable signing", resolveScriptDbTarget(RDS, { DB_IAM_AUTH: "false" }).mode, "url"],
    ["DB_IAM_AUTH=true on an rds host resolves to iam", resolveScriptDbTarget(RDS, { DB_IAM_AUTH: "true" }).mode, "iam"],
    ["DB_IAM_AUTH=1 is also honoured", resolveScriptDbTarget(RDS, { DB_IAM_AUTH: "1" }).mode, "iam"],
    ["the region is read out of the rds hostname", resolveScriptDbTarget(RDS, { DB_IAM_AUTH: "true" }).region, "ap-south-1"],
    ["the username is carried through for signing", resolveScriptDbTarget(RDS, { DB_IAM_AUTH: "true" }).username, "streamline_admin"],
    ["the database name is carried through", resolveScriptDbTarget(RDS, { DB_IAM_AUTH: "true" }).database, "streamlineos"],
    ["a non-rds host with DB_IAM_AUTH falls back to AWS_REGION", resolveScriptDbTarget(LOCAL, { DB_IAM_AUTH: "true", AWS_REGION: "eu-west-1" }).region, "eu-west-1"],
    ["a non-rds host with no region is refused rather than signed blind", resolveScriptDbTarget(LOCAL, { DB_IAM_AUTH: "true" }).mode, "iam-unresolved"],
    ["a url with no username is refused rather than signed for an empty principal", resolveScriptDbTarget("postgresql://host.ap-south-1.rds.amazonaws.com:5432/app", { DB_IAM_AUTH: "true" }).mode, "iam-unresolved"],
  ];

  let failed = 0;
  for (const [name, actual, expected] of cases)
    if (actual !== expected) {
      console.error(`FAIL: ${name} — expected '${expected}', got '${actual}'`);
      failed++;
    }
  if (failed) process.exit(1);
  console.log(`PASS: ${label} script sql client, ${cases.length} cases.`);
  process.exit(0);
}
