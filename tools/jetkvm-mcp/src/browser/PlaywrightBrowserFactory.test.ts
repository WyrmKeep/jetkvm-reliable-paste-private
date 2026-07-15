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
    fill: vi.fn(async (value: string, _options?: { timeout: number }) => {
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
        timeout: expect.any(Number),
      });
      const fillTimeout = delayed.password.fill.mock.calls[0]?.[1]?.timeout;
      expect(fillTimeout).toBeGreaterThan(0);
      expect(fillTimeout).toBeLessThanOrEqual(2_000);
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
        timeout: 2_000,
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
        timeout: 2_000,
        args: ["--unsafely-treat-insecure-origin-as-secure=http://192.0.2.42"],
      });
    } finally {
      await factory.dispose();
      secret.dispose();
    }
  });
  it("cancels pending navigation without waiting for its numeric timeout", async () => {
    const navigation = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const page = {
      goto: vi.fn(() => navigation.promise),
      close: vi.fn(() => closing.promise),
    };
    const context = { newPage: vi.fn(async () => page) };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
    };
    const secret = DisposableSecret.fromBytes(new Uint8Array([1]));
    const factory = new PlaywrightBrowserFactory({
      targetUrl: "https://jetkvm.test",
      credential: secret,
      launch: vi.fn(async () => browser) as unknown as typeof chromium.launch,
    });
    const cancellation = new AbortController();
    let settled = false;
    let failure: unknown;
    const operation = factory
      .open({ timeoutMs: 60_000, signal: cancellation.signal })
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(page.goto).toHaveBeenCalledOnce());

    cancellation.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeNavigation = settled;
    navigation.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeClose = settled;
    closing.resolve();
    await operation;

    expect(settledBeforeNavigation).toBe(true);
    expect(settledBeforeClose).toBe(true);
    expect(failure).toMatchObject({ code: "CANCELLED" });
    expect(page.close).toHaveBeenCalledOnce();
    await factory.dispose();
    secret.dispose();
  });
  it("closes a page that resolves after cancellation", async () => {
    const createdPage = Promise.withResolvers<{
      close: ReturnType<typeof vi.fn>;
    }>();
    const page = { close: vi.fn(async () => undefined) };
    const context = { newPage: vi.fn(() => createdPage.promise) };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
    };
    const secret = DisposableSecret.fromBytes(new Uint8Array([1]));
    const factory = new PlaywrightBrowserFactory({
      targetUrl: "https://jetkvm.test",
      credential: secret,
      launch: vi.fn(async () => browser) as unknown as typeof chromium.launch,
    });
    const cancellation = new AbortController();
    const operation = factory
      .open({ timeoutMs: 60_000, signal: cancellation.signal })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(context.newPage).toHaveBeenCalledOnce());

    cancellation.abort();
    await expect(operation).resolves.toMatchObject({ code: "CANCELLED" });
    createdPage.resolve(page);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(page.close).toHaveBeenCalledOnce();
    await factory.dispose();
    secret.dispose();
  });
  it("observes cleanup rejection from a browser launched after cancellation", async () => {
    const launched = Promise.withResolvers<{
      close: ReturnType<typeof vi.fn>;
    }>();
    const browser = {
      close: vi.fn(async () => {
        throw new Error("late close failed");
      }),
    };
    const launch = vi.fn(
      () => launched.promise,
    ) as unknown as typeof chromium.launch;
    const secret = DisposableSecret.fromBytes(new Uint8Array([1]));
    const factory = new PlaywrightBrowserFactory({
      targetUrl: "https://jetkvm.test",
      credential: secret,
      launch,
    });
    const cancellation = new AbortController();
    const operation = factory
      .open({ timeoutMs: 60_000, signal: cancellation.signal })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());

    cancellation.abort();
    await expect(operation).resolves.toMatchObject({ code: "CANCELLED" });
    launched.resolve(browser);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(browser.close).toHaveBeenCalledOnce();
    await factory.dispose();
    secret.dispose();
  });
});
