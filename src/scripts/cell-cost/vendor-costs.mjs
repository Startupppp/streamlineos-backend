const NEON_API_BASE = "https://console.neon.tech/api/v2";
const ABLY_REST_BASE = "https://rest.ably.io";
const CF_API_BASE = "https://api.cloudflare.com/client/v4";

async function safeFetch(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function fetchNeonConsumption(env) {
  const apiKey = env.NEON_API_KEY;
  const projectId = env.NEON_PROJECT_ID;
  const missing = [];
  if (!apiKey) missing.push("NEON_API_KEY");
  if (!projectId) missing.push("NEON_PROJECT_ID");
  if (missing.length > 0) {
    return {
      status: "refused",
      envVars: missing,
      reason: `Set ${missing.join(" and ")} (Neon console → Account Settings → API Keys; project ID from project settings).`,
    };
  }

  try {
    const data = await safeFetch(`${NEON_API_BASE}/projects/${encodeURIComponent(projectId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const p = data.project ?? {};
    // Neon names these compute_time_seconds and data_storage_bytes_hour. Reading
    // compute_time and storage_bytes_hour returned undefined, so the two largest
    // cost drivers reported as "unavailable" while the API was returning them —
    // a null that looks like a vendor limitation and is really a typo. The older
    // names are kept as fallbacks in case the field set differs by plan.
    const computeTimeSeconds = p.compute_time_seconds ?? p.compute_time ?? null;
    const storageBytesHour = p.data_storage_bytes_hour ?? p.storage_bytes_hour ?? null;
    return {
      status: "ok",
      computeTimeSeconds,
      activeTimeSeconds: p.active_time_seconds ?? null,
      syntheticStorageGib:
        p.synthetic_storage_size != null ? p.synthetic_storage_size / 1024 ** 3 : null,
      consumptionPeriodStart: p.consumption_period_start ?? null,
      consumptionPeriodEnd: p.consumption_period_end ?? null,
      storageGibHours: storageBytesHour != null ? storageBytesHour / 1024 ** 3 : null,
      dataTransferGib: p.data_transfer_bytes != null ? p.data_transfer_bytes / (1024 ** 3) : null,
      writtenDataGib: p.written_data_bytes != null ? p.written_data_bytes / (1024 ** 3) : null,
      rateEnvVars: ["NEON_COMPUTE_RATE_USD_PER_HOUR", "NEON_STORAGE_RATE_USD_PER_GIB_MONTH", "NEON_TRANSFER_RATE_USD_PER_GIB"],
      rateNote: "Consumption figures fetched; dollar cost requires the three rate env vars above, set from your Neon invoice.",
    };
  } catch (err) {
    return { status: "error", reason: String(err.message ?? err) };
  }
}

export async function fetchAblyStats(env) {
  const apiKey = env.ABLY_API_KEY;
  if (!apiKey) {
    return {
      status: "refused",
      envVars: ["ABLY_API_KEY"],
      reason: "Set ABLY_API_KEY (Ably dashboard → API Keys).",
    };
  }

  const colonIndex = apiKey.indexOf(":");
  if (colonIndex === -1) return { status: "error", reason: "ABLY_API_KEY must be in appId.keyId:secret format." };

  const keyId = apiKey.slice(0, colonIndex);
  const keySecret = apiKey.slice(colonIndex + 1);
  const basic = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

  try {
    const data = await safeFetch(`${ABLY_REST_BASE}/stats?unit=month&count=1&direction=backwards`, {
      headers: { Authorization: `Basic ${basic}` },
    });

    const entry = Array.isArray(data) ? data[0] : null;
    if (!entry) return { status: "ok", channelMinutes: null, connectionMinutes: null, messageCount: null, note: "No stats entries for the current month." };

    const connMean = entry.connections?.all?.mean ?? null;
    const channelMean = entry.channels?.all?.mean ?? null;
    const channelPeak = entry.channels?.all?.peak ?? null;
    const msgIn = entry.inbound?.all?.messages?.count ?? 0;
    const msgOut = entry.outbound?.all?.messages?.count ?? 0;
    const intervalUnit = entry.unit ?? "month";
    const intervalMinutes = intervalUnit === "month" ? 30 * 24 * 60 : intervalUnit === "day" ? 24 * 60 : 60;

    const connectionMinutes = connMean != null ? Math.round(connMean * intervalMinutes) : null;
    const channelMinutes = channelMean != null
      ? Math.round(channelMean * intervalMinutes)
      : channelPeak != null
        ? Math.round(channelPeak * intervalMinutes)
        : null;

    return {
      status: "ok",
      channelMinutes,
      connectionMinutes,
      messageCount: msgIn + msgOut,
      intervalUnit,
      note: channelMean != null
        ? "Channel-minutes = channelMean * intervalMinutes (mean-based, most accurate)."
        : "Channel-minutes estimated from peak (mean not in response); may overcount.",
    };
  } catch (err) {
    return { status: "error", reason: String(err.message ?? err) };
  }
}

export async function fetchResendStats(env) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      status: "refused",
      envVars: ["RESEND_API_KEY"],
      reason: "Set RESEND_API_KEY (Resend dashboard → API Keys).",
    };
  }
  return {
    status: "no-billing-api",
    note: "Resend does not expose per-email cost or billing totals via its public REST API. Dollar cost per notification = (notifications count from DB) * (per-email rate from your Resend invoice). The key is present; no dollar figure is derivable from the API alone.",
  };
}

export async function fetchCloudflareR2Stats(env) {
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const missing = [];
  if (!apiToken) missing.push("CLOUDFLARE_API_TOKEN");
  if (!accountId) missing.push("CLOUDFLARE_ACCOUNT_ID");
  if (missing.length > 0) {
    return {
      status: "refused",
      envVars: missing,
      reason: `Set ${missing.join(" and ")} (Cloudflare dashboard → My Profile → API Tokens; account ID from any zone overview URL). Note: R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY are S3-compat keys and cannot query billing analytics.`,
    };
  }

  const bucketName = env.R2_BUCKET_NAME;
  if (!bucketName) return { status: "refused", envVars: ["R2_BUCKET_NAME"], reason: "R2_BUCKET_NAME required to scope R2 analytics query." };

  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);

  const CLASS_A = new Set(["ListBuckets", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "ListMultipartUploads", "UploadPart", "DeleteObject", "DeleteObjects"]);
  const CLASS_B = new Set(["GetObject", "HeadObject", "HeadBucket"]);

  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        r2StorageAdaptiveGroups(
          filter: { date_geq: "${from}", date_leq: "${to}", bucketName: "${bucketName}" }
          limit: 1
        ) { sum { objectCount payloadSize } }
        r2OperationsAdaptiveGroups(
          filter: { date_geq: "${from}", date_leq: "${to}", bucketName: "${bucketName}" }
          limit: 10000
        ) { sum { requests } dimensions { actionType } }
      }
    }
  }`;

  try {
    const data = await safeFetch(`${CF_API_BASE}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    const acct = data?.data?.viewer?.accounts?.[0];
    const storage = acct?.r2StorageAdaptiveGroups?.[0]?.sum ?? {};
    const ops = acct?.r2OperationsAdaptiveGroups ?? [];
    const classA = ops.filter((o) => CLASS_A.has(o.dimensions?.actionType)).reduce((s, o) => s + (o.sum?.requests ?? 0), 0);
    const classB = ops.filter((o) => CLASS_B.has(o.dimensions?.actionType)).reduce((s, o) => s + (o.sum?.requests ?? 0), 0);

    return {
      status: "ok",
      storageBytes: Number(storage.payloadSize ?? 0),
      objectCount: Number(storage.objectCount ?? 0),
      classAOperations: classA,
      classBOperations: classB,
      rateEnvVars: ["CLOUDFLARE_R2_CLASS_A_RATE_USD_PER_MILLION", "CLOUDFLARE_R2_CLASS_B_RATE_USD_PER_MILLION", "CLOUDFLARE_R2_STORAGE_RATE_USD_PER_GB_MONTH"],
      rateNote: "Usage figures fetched; dollar cost requires the three rate env vars above, set from your Cloudflare R2 invoice.",
    };
  } catch (err) {
    return { status: "error", reason: String(err.message ?? err) };
  }
}
