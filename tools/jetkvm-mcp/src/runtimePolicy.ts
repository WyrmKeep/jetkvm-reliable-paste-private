export const SUPPORTED_NODE_RANGE = ">=22.23.1 <23";

export function assertSupportedNodeVersion(version = process.versions.node): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const supported =
    match !== null &&
    Number(match[1]) === 22 &&
    (Number(match[2]) > 23 || (Number(match[2]) === 23 && Number(match[3]) >= 1));

  if (!supported) {
    throw new Error(`Unsupported Node.js ${version}; expected ${SUPPORTED_NODE_RANGE}`);
  }
  return version;
}
