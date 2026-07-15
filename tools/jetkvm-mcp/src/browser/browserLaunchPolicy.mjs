const INSECURE_ORIGIN_FLAG = "--unsafely-treat-insecure-origin-as-secure=";

/**
 * Returns the exact security-affecting Chromium arguments for one target.
 *
 * @param {string} targetUrl
 * @returns {string[]}
 */
export function browserLaunchArgsForTarget(targetUrl) {
  const target = new URL(targetUrl);
  return target.protocol === "http:"
    ? [`${INSECURE_ORIGIN_FLAG}${target.origin}`]
    : [];
}
