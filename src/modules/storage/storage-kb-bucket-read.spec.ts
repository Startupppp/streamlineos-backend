import { Readable } from "node:stream";
import { StorageService } from "./storage.service";

const ORG = "org-a";
const KB_BUCKET = "kb-bucket";
const DEFAULT_BUCKET = "default-bucket";

function makeService(kbBucket: string | undefined): {
  service: StorageService;
  buckets: string[];
} {
  const buckets: string[] = [];
  const service = new StorageService(
    {} as never,
    {
      R2_REGION: "auto",
      R2_BUCKET_NAME: DEFAULT_BUCKET,
      R2_KB_BUCKET_NAME: kbBucket,
      R2_ACCESS_KEY_ID: "id",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_ENDPOINT: "https://r2.example.com",
      NEXT_PUBLIC_R2_PUBLIC_URL: "",
    } as never,
    { isKeyBlocked: jest.fn().mockResolvedValue(false) } as never,
  );
  const placement = {
    client: {
      send: jest.fn().mockResolvedValue({
        Body: new Readable({ read() {} }),
        ContentType: "image/webp",
        ContentLength: 4,
      }),
    },
    bucketName: DEFAULT_BUCKET,
  };
  const resolver = service as unknown as {
    placement: {
      forOrg: () => Promise<unknown>;
      requireBucket: (p: unknown, override?: string) => string;
    };
  };
  const requireBucket = resolver.placement.requireBucket.bind(resolver.placement);
  resolver.placement.forOrg = () => Promise.resolve(placement);
  resolver.placement.requireBucket = (p: unknown, override?: string) => {
    const chosen = requireBucket(p, override);
    buckets.push(chosen);
    return chosen;
  };
  return { service, buckets };
}

describe("StorageService — a KB key reads from the bucket its upload wrote to", () => {
  it("streams a kb-media key from the KB bucket, not the default one", async () => {
    const { service, buckets } = makeService(KB_BUCKET);

    await service.getFileStream(ORG, `${ORG}/kb-media/${ORG}/cover.webp`);

    expect(buckets).toEqual([KB_BUCKET]);
  });

  it("streams a kb-sources key from the KB bucket", async () => {
    const { service, buckets } = makeService(KB_BUCKET);

    await service.getFileStream(ORG, `${ORG}/kb-sources/${ORG}/manual.pdf`);

    expect(buckets).toEqual([KB_BUCKET]);
  });

  it("CONTROL: a non-KB key still reads from the default bucket", async () => {
    const { service, buckets } = makeService(KB_BUCKET);

    await service.getFileStream(ORG, `${ORG}/uploads/plain.pdf`);

    expect(buckets).toEqual([DEFAULT_BUCKET]);
  });

  it("falls back to the default bucket when no dedicated KB bucket is configured", async () => {
    const { service, buckets } = makeService(undefined);

    await service.getFileStream(ORG, `${ORG}/kb-media/${ORG}/cover.webp`);

    expect(buckets).toEqual([DEFAULT_BUCKET]);
  });

  it("an explicit override still wins over the key-derived bucket", async () => {
    const { service, buckets } = makeService(KB_BUCKET);

    await service.getFileStream(ORG, `${ORG}/kb-media/${ORG}/cover.webp`, "explicit-bucket");

    expect(buckets).toEqual(["explicit-bucket"]);
  });
});
