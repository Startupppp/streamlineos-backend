import { DelhiveryHttpCarrierAdapter, DEFAULT_DELHIVERY_SANDBOX_URL } from "../delhivery-http.adapter";
import type { CarrierAccount, CarrierBookingRequest } from "../carrier-transport.port";
import type { CarrierHttp } from "../carrier-http";

describe("DelhiveryHttpCarrierAdapter (INV-26)", () => {
  const dummyAccount: CarrierAccount = {
    carrierCode: "DELHIVERY_EXPRESS",
    baseUrl: "https://staging-express.delhivery.com",
    credential: "test-delhivery-token-12345",
  };

  const bookingRequest: CarrierBookingRequest = {
    shipmentNumber: "SHP-10001",
    destinationAddress: "123 MG Road, Bengaluru, KA 560001",
    destinationPin: "560001",
    destinationPhone: "9876543210",
    originName: "Bengaluru Hub",
    parcels: [
      {
        reference: "PKG-1",
        declaredWeight: "1.5",
        declaredLength: "20",
        declaredWidth: "15",
        declaredHeight: "10",
      },
    ],
  };

  it("refuses booking with MISSING_CREDENTIALS when credentials are missing", async () => {
    const adapter = new DelhiveryHttpCarrierAdapter();
    const result = await adapter.book(
      { carrierCode: "DELHIVERY", baseUrl: "", credential: "" },
      bookingRequest,
    );

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.errors[0]?.code).toBe("MISSING_CREDENTIALS");
    }
  });

  it("refuses booking with MISSING_DESTINATION_PIN when pin is missing", async () => {
    const adapter = new DelhiveryHttpCarrierAdapter();
    const invalidRequest: CarrierBookingRequest = {
      shipmentNumber: "SHP-10002",
      destinationAddress: "No Pin Address",
      parcels: [],
    };
    const result = await adapter.book(dummyAccount, invalidRequest);

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.errors[0]?.code).toBe("MISSING_DESTINATION_PIN");
    }
  });

  it("books a shipment successfully with real PIN, phone, and pickup location", async () => {
    const mockHttp: CarrierHttp = {
      request: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: {
          success: true,
          packages: [{ waybill: "123456789012", refnum: "SHP-10001" }],
        },
      }),
    };

    const adapter = new DelhiveryHttpCarrierAdapter(mockHttp);
    const result = await adapter.book(dummyAccount, bookingRequest);

    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") {
      expect(result.value.trackingNumber).toBe("123456789012");
      expect(result.value.label?.url).toContain("123456789012");
      expect(result.value.label?.format).toBe("PDF");
    }

    expect(mockHttp.request).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          data: expect.objectContaining({
            shipments: [
              expect.objectContaining({
                pin: "560001",
                phone: "9876543210",
                order: "SHP-10001",
              }),
            ],
            pickup_location: { name: "Bengaluru Hub" },
          }),
        }),
      }),
    );
  });

  it("returns rejected when Delhivery returns a 4xx error", async () => {
    const mockHttp: CarrierHttp = {
      request: jest.fn().mockResolvedValue({
        ok: true,
        status: 400,
        body: { error: "Invalid pincode" },
      }),
    };

    const adapter = new DelhiveryHttpCarrierAdapter(mockHttp);
    const result = await adapter.book(dummyAccount, bookingRequest);

    expect(result.outcome).toBe("rejected");
  });

  it("returns unavailable when Delhivery server returns 5xx error or times out", async () => {
    const mockHttp: CarrierHttp = {
      request: jest.fn().mockResolvedValue({
        ok: false,
        reason: "HTTP 503 Service Unavailable",
      }),
    };

    const adapter = new DelhiveryHttpCarrierAdapter(mockHttp);
    const result = await adapter.book(dummyAccount, bookingRequest);

    expect(result.outcome).toBe("unavailable");
  });

  it("fetches label URL correctly for a waybill", async () => {
    const adapter = new DelhiveryHttpCarrierAdapter();
    const result = await adapter.fetchLabel(dummyAccount, "123456789012");

    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") {
      expect(result.value.url).toContain("123456789012");
      expect(result.value.format).toBe("PDF");
    }
  });

  it("tracks shipment scans from Delhivery API", async () => {
    const mockHttp: CarrierHttp = {
      request: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: {
          ShipmentData: [
            {
              Shipment: {
                AWB: "123456789012",
                Status: { Status: "In Transit", StatusDateTime: "2026-09-12T10:00:00Z" },
                Scans: [
                  {
                    ScanDetail: {
                      ScanDateTime: "2026-09-12T10:00:00Z",
                      ScanType: "In Transit",
                      Scan: "Package arrived at Bengaluru hub",
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    };

    const adapter = new DelhiveryHttpCarrierAdapter(mockHttp);
    const result = await adapter.track(dummyAccount, "123456789012");

    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].status).toBe("SHIPPED");
    }
  });

  it("verifies webhook signature correctly", () => {
    const adapter = new DelhiveryHttpCarrierAdapter();
    const secret = "a".repeat(32);
    const rawBody = JSON.stringify({ waybill: "123456789012", status: "Delivered", occurredAt: "2026-09-12T12:00:00Z" });

    const verification = adapter.verifyWebhook({
      secret,
      rawBody,
      headers: { "x-delhivery-signature": secret },
    });

    expect(verification.valid).toBe(true);
  });

  it("parses inbound webhook payload into CarrierWebhookEvent", () => {
    const adapter = new DelhiveryHttpCarrierAdapter();
    const rawBody = JSON.stringify({
      eventId: "EVT-999",
      waybill: "123456789012",
      status: "Delivered",
      occurredAt: "2026-09-12T12:00:00Z",
      description: "Package delivered to recipient",
    });

    const parsed = adapter.parseWebhook(rawBody);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.eventKey).toBe("EVT-999");
      expect(parsed.value.event.status).toBe("DELIVERED");
      expect(parsed.value.event.trackingNumber).toBe("123456789012");
    }
  });

  const maybeLive = process.env.DELHIVERY_SANDBOX_TOKEN ? it : it.skip;
  maybeLive("optional live spec against Delhivery sandbox API", async () => {
    const liveAccount: CarrierAccount = {
      carrierCode: "DELHIVERY_LIVE",
      baseUrl: DEFAULT_DELHIVERY_SANDBOX_URL,
      credential: process.env.DELHIVERY_SANDBOX_TOKEN!,
    };
    const adapter = new DelhiveryHttpCarrierAdapter();
    const result = await adapter.book(liveAccount, bookingRequest);
    expect(result.outcome).toBeDefined();
  });
});
