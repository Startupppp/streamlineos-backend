const RDS_HOST = /\.([a-z0-9-]+)\.rds\.amazonaws\.com$/i;

export function isRdsIamAuthEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.DB_IAM_AUTH?.trim().toLowerCase();
  return value === "true" || value === "1";
}

export function rdsRegionFor(host: string, env: NodeJS.ProcessEnv): string | undefined {
  const matched = RDS_HOST.exec(host);
  if (matched?.[1]) return matched[1];
  return env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? undefined;
}

export interface RdsIamTarget {
  host: string;
  port: number;
  username: string;
  region: string;
}

export function createRdsIamPasswordProvider(target: RdsIamTarget): () => Promise<string> {
  return async () => {
    const { Signer } = await import("@aws-sdk/rds-signer");
    const signer = new Signer({
      hostname: target.host,
      port: target.port,
      region: target.region,
      username: target.username,
    });
    return signer.getAuthToken();
  };
}
