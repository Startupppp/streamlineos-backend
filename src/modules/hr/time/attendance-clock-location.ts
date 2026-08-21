export function calculateDistanceMeters(
  firstLatitude: number,
  firstLongitude: number,
  secondLatitude: number,
  secondLongitude: number,
): number {
  const earthRadiusMeters = 6_371_000;
  const latitudeDelta = ((secondLatitude - firstLatitude) * Math.PI) / 180;
  const longitudeDelta = ((secondLongitude - firstLongitude) * Math.PI) / 180;
  const angularDistance =
    Math.sin(latitudeDelta / 2) * Math.sin(latitudeDelta / 2) +
    Math.cos((firstLatitude * Math.PI) / 180) *
      Math.cos((secondLatitude * Math.PI) / 180) *
      Math.sin(longitudeDelta / 2) *
      Math.sin(longitudeDelta / 2);
  return (
    earthRadiusMeters *
    2 *
    Math.atan2(Math.sqrt(angularDistance), Math.sqrt(1 - angularDistance))
  );
}
