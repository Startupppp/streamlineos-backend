import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";

async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`✓ Bucket "${bucket}" already exists`);
    return;
  } catch {
    // bucket missing — create it below
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`✓ Created bucket "${bucket}"`);
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") {
      console.log(`✓ Bucket "${bucket}" already exists`);
      return;
    }
    throw err;
  }
}

async function ensurePublicReadCors(client: S3Client, bucket: string): Promise<void> {
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ["*"],
            AllowedMethods: ["GET", "HEAD"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag", "Content-Length", "Content-Type"],
            MaxAgeSeconds: 86400,
          },
        ],
      },
    }),
  );
  console.log(`✓ CORS (GET/HEAD *) applied on "${bucket}"`);
}

async function main(): Promise<void> {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    console.error(
      "Missing R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in env",
    );
    process.exit(1);
  }

  const client = new S3Client({
    region: process.env.R2_REGION || "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  const buckets = [
    process.env.R2_BUCKET_NAME,
    process.env.R2_KB_BUCKET_NAME,
  ].filter((b): b is string => Boolean(b));

  if (buckets.length === 0) {
    console.error("No bucket names set (R2_BUCKET_NAME / R2_KB_BUCKET_NAME)");
    process.exit(1);
  }

  for (const bucket of buckets) {
    await ensureBucket(client, bucket);
    await ensurePublicReadCors(client, bucket);
  }

  console.log(
    "\nNext: in the Cloudflare dashboard enable public access on the KB bucket,",
  );
  console.log(
    "then set R2_KB_PUBLIC_URL to its public/CDN URL so uploaded images display.",
  );
  console.log(
    "Public-read CORS is set so in-browser capture (snapDOM) can embed R2 images.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
