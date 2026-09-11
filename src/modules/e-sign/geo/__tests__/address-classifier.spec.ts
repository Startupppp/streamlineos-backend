import { classifyAddress } from "../address-classifier";
import { AddressGeoIp } from "../address-geo-ip";

/**
 * What an audit row can honestly say about a signer's address.
 *
 * The point of classifying at all is the private and loopback cases. A
 * signature recorded from `127.0.0.1` or `10.x` means the request reached the
 * application without a forwarded client address — the audit trail is saying
 * "signed from the server", which is a real finding and one that a null
 * `geolocation_json` column hid completely.
 */
describe("classifyAddress", () => {
  /*
  A genuinely routable address, not a documentation range. The classifier
  shares one table with the outbound guard now, and that table names
  192.0.2/24, 198.51.100/24 and 203.0.113/24 as reserved — which they are.
  Using one here asserted that a reserved range reads as public.
*/
it("recognises ordinary public addresses", () => {
    expect(classifyAddress("93.184.216.34")).toEqual({ family: "ipv4", scope: "public" });
    expect(classifyAddress("2606:4700:4700::1111")).toEqual({ family: "ipv6", scope: "public" });
  });

  it("names the loopback, which is the interesting one", () => {
    expect(classifyAddress("127.0.0.1")).toEqual({ family: "ipv4", scope: "loopback" });
    expect(classifyAddress("::1")).toEqual({ family: "ipv6", scope: "loopback" });
  });

  it("recognises every private IPv4 range, including carrier-grade NAT", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.1", "100.64.0.1"]) {
      expect(classifyAddress(ip).scope).toBe("private");
    }
  });

  /** 172.15 and 172.32 are outside the private block and must stay public. */
  it("does not over-claim the 172 block", () => {
    expect(classifyAddress("172.15.0.1").scope).toBe("public");
    expect(classifyAddress("172.32.0.1").scope).toBe("public");
  });

  it("recognises reserved ranges", () => {
    expect(classifyAddress("169.254.1.1").scope).toBe("reserved");
    expect(classifyAddress("0.0.0.0").scope).toBe("reserved");
    expect(classifyAddress("239.255.255.250").scope).toBe("reserved");
    /** RFC 2544 benchmark space, which the SSRF guard permits and tests use. */
    expect(classifyAddress("198.18.0.1").scope).toBe("reserved");
  });

  it("recognises IPv6 unique-local and link-local", () => {
    expect(classifyAddress("fd00::1").scope).toBe("private");
    expect(classifyAddress("fe80::1").scope).toBe("reserved");
  });

  /**
   * An IPv4 client on a dual-stack socket arrives as `::ffff:93.184.216.34`.
   * Calling that IPv6 would report an address family the signer's device has
   * never used.
   */
  it("unwraps IPv4-mapped IPv6 rather than mislabelling the family", () => {
    expect(classifyAddress("::ffff:93.184.216.34")).toEqual({ family: "ipv4", scope: "public" });
    expect(classifyAddress("::ffff:10.0.0.1")).toEqual({ family: "ipv4", scope: "private" });
  });

  it("says unknown rather than guessing", () => {
    expect(classifyAddress(null)).toEqual({ family: "unknown", scope: "unknown" });
    expect(classifyAddress("")).toEqual({ family: "unknown", scope: "unknown" });
    expect(classifyAddress("not-an-address")).toEqual({ family: "unknown", scope: "unknown" });
    expect(classifyAddress("999.1.1.1")).toEqual({ family: "unknown", scope: "unknown" });
  });
});

describe("AddressGeoIp", () => {
  const geo = new AddressGeoIp();

  it("records how much it knows, not just what it found", async () => {
    const located = await geo.locate("93.184.216.34");

    expect(located).toMatchObject({
      ip: "93.184.216.34",
      family: "ipv4",
      scope: "public",
      country: null,
      source: "address-classification",
      confidence: "none",
    });
    /**
     * The note is the difference between "we did not look" and "we looked and
     * found nothing". Without it a null country is unreadable.
     */
    expect(located!.note).toMatch(/no geo-ip provider is configured/i);
  });

  it("still returns a row for an address it cannot parse", async () => {
    const located = await geo.locate("nonsense");
    expect(located).toMatchObject({ family: "unknown", scope: "unknown", confidence: "none" });
  });

  it("returns a row even with no address at all", async () => {
    const located = await geo.locate(null);
    expect(located).toMatchObject({ ip: null, family: "unknown" });
  });
});
