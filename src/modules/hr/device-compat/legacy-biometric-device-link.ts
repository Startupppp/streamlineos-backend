const LEGACY_BIOMETRIC_SERIAL_PREFIX = "legacy-biometric-device:";

export function legacyBiometricDeviceSerial(legacyDeviceId: number): string {
  if (!Number.isSafeInteger(legacyDeviceId) || legacyDeviceId <= 0)
    throw new Error("Legacy biometric device id must be a positive safe integer");
  return `${LEGACY_BIOMETRIC_SERIAL_PREFIX}${legacyDeviceId}`;
}

export function legacyBiometricDeviceId(serialNumber: string): number | null {
  if (!serialNumber.startsWith(LEGACY_BIOMETRIC_SERIAL_PREFIX)) return null;
  const rawId = serialNumber.slice(LEGACY_BIOMETRIC_SERIAL_PREFIX.length);
  if (!/^[1-9]\d*$/.test(rawId)) return null;
  const deviceId = Number(rawId);
  return Number.isSafeInteger(deviceId) ? deviceId : null;
}
