import {
  legacyBiometricDeviceId,
  legacyBiometricDeviceSerial,
} from "./legacy-biometric-device-link";

describe("legacy biometric device link", () => {
  it("round-trips a legacy device id through the canonical serial field", () => {
    const serial = legacyBiometricDeviceSerial(42);

    expect(serial).toBe("legacy-biometric-device:42");
    expect(legacyBiometricDeviceId(serial)).toBe(42);
  });

  it.each([
    "device-42",
    "legacy-biometric-device:0",
    "legacy-biometric-device:-1",
    "legacy-biometric-device:2.5",
    "legacy-biometric-device:not-a-number",
  ])("does not infer a legacy link from %s", (serial) => {
    expect(legacyBiometricDeviceId(serial)).toBeNull();
  });
});
