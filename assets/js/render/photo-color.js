// Photo sampling workaround only. Mathematical renderers retain native colors.
export function isLinuxFirefox(browser = globalThis.navigator) {
  const userAgent = browser?.userAgent || "";
  return (
    /Firefox/i.test(userAgent) &&
    /Linux|X11/i.test(userAgent || browser?.platform || "")
  );
}
