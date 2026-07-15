import { describe, expect, it, vi } from "vitest";
import { chromium } from "playwright-core";

import { DisposableSecret } from "./auth.js";
import { PlaywrightBrowserFactory } from "./PlaywrightBrowserFactory.js";

function delayedLoginBrowser() {
  let loginReady = false;
  let passwordCounted = false;
  let authenticated = false;
  let filledPassword: string | null = null;
  const form = {
    press: vi.fn(async () => {
      authenticated = filledPassword === "delayed-password";
    }),
  };
  const password = {
    count: vi.fn(async () => {
      passwordCounted = true;
      return loginReady ? 1 : 0;
    }),
    fill: vi.fn(async (value: string) => {
      filledPassword = value;
    }),
    locator: vi.fn(() => form),
  };
  const page = {
    goto: vi.fn(async () => undefined),
    locator: vi.fn(() => password),
    waitForURL: vi.fn(async () => undefined),
    waitForFunction: vi.fn(async () => {
      if (!passwordCounted) {
        loginReady = true;
        return;
      }
      if (!authenticated) throw new Error("Application is not authenticated.");
    }),
    close: vi.fn(async () => undefined),
  };
  const context = { newPage: vi.fn(async () => page) };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
  return {
    launch: vi.fn(async () => browser) as unknown as typeof chromium.launch,
    password,
  };
}

describe("PlaywrightBrowserFactory", () => {
  it("waits for an asynchronously rendered login form before checking authentication", async () => {
    const delayed = delayedLoginBrowser();
    const secret = DisposableSecret.fromBytes(
      new TextEncoder().encode("delayed-password"),
    );
    const factory = new PlaywrightBrowserFactory({
      targetUrl: "https://jetkvm.test",
      credential: secret,
      launch: delayed.launch,
    });
    try {
      await expect(
        factory.open({
          timeoutMs: 2_000,
          signal: new AbortController().signal,
        }),
      ).resolves.toBeDefined();
      expect(delayed.password.fill).toHaveBeenCalledWith("delayed-password", {
        timeout: 2_000,
      });
    } finally {
      await factory.dispose();
      secret.dispose();
    }
  });
  it("passes the configured headless mode and executable path to Chromium", async () => {
    const delayed = delayedLoginBrowser();
    const secret = DisposableSecret.fromBytes(
      new TextEncoder().encode("delayed-password"),
    );
    const factory = new PlaywrightBrowserFactory({
      targetUrl: "https://jetkvm.test",
      credential: secret,
      headless: false,
      executablePath: "/operator/chromium",
      launch: delayed.launch,
    });
    try {
      await factory.open({
        timeoutMs: 2_000,
        signal: new AbortController().signal,
      });
      expect(delayed.launch).toHaveBeenCalledWith({
        headless: false,
        chromiumSandbox: true,
        executablePath: "/operator/chromium",
      });
    } finally {
      await factory.dispose();
      secret.dispose();
    }
  });
  it("treats only the configured insecure target origin as a secure context", async () => {
    const delayed = delayedLoginBrowser();
    const secret = DisposableSecret.fromBytes(
      new TextEncoder().encode("delayed-password"),
    );
    const factory = new PlaywrightBrowserFactory({
      targetUrl: "http://192.0.2.42/devices/serial?view=kvm",
      credential: secret,
      launch: delayed.launch,
    });
    try {
      await factory.open({
        timeoutMs: 2_000,
        signal: new AbortController().signal,
      });
      expect(delayed.launch).toHaveBeenCalledWith({
        headless: true,
        chromiumSandbox: true,
        args: ["--unsafely-treat-insecure-origin-as-secure=http://192.0.2.42"],
      });
    } finally {
      await factory.dispose();
      secret.dispose();
    }
  });
});
