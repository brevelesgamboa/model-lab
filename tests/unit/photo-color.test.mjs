import test from "node:test";
import assert from "node:assert/strict";
import { isLinuxFirefox } from "../../assets/js/render/photo-color.js";

test("photo correction defaults only to Linux/X11 Firefox", () => {
  for (const [userAgent, expected] of [
    [
      "Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0",
      true,
    ],
    ["Mozilla/5.0 (X11; rv:155.0) Gecko/20100101 Firefox/155.0", true],
    ["Mozilla/5.0 (X11; Linux x86_64) Chrome/143.0 Safari/537.36", false],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Firefox/155.0",
      false,
    ],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X) Firefox/155.0", false],
    ["Mozilla/5.0 (iPhone) FxiOS/155.0", false],
  ])
    assert.equal(isLinuxFirefox({ userAgent }), expected, userAgent);
});

test("missing browser metadata is safe in headless and non-browser callers", () => {
  for (const browser of [
    null,
    {},
    { platform: "Linux x86_64" },
    { userAgent: "" },
  ])
    assert.equal(isLinuxFirefox(browser), false);
});
