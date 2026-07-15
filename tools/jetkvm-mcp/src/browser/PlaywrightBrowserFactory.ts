import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";

import { browserLaunchArgsForTarget } from "./browserLaunchPolicy.mjs";

import type { Deadline } from "../device/DeviceRpcAdapter.js";
import { BrowserPlaneError } from "./bridgeProtocol.js";
import {
  BrowserController,
  createBrowserDeadlineBudget,
  type BrowserControllerPort,
} from "./BrowserController.js";
import type { BrowserControllerFactory } from "./ManagedBrowserController.js";
import type { DisposableSecret } from "./auth.js";

const CONNECT_POLL_MS = 100;

export interface PlaywrightBrowserFactoryOptions {
  readonly targetUrl: string;
  readonly credential: DisposableSecret;
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly launch?: typeof chromium.launch;
}

export class PlaywrightBrowserFactory implements BrowserControllerFactory {
  readonly #targetUrl: string;
  readonly #credential: DisposableSecret;
  readonly #headless: boolean;
  readonly #executablePath: string | undefined;
  readonly #launchArgs: string[];
  readonly #launch: typeof chromium.launch;
  #browser: Browser | null = null;
  #context: BrowserContext | null = null;
  #disposed = false;

  public constructor(options: PlaywrightBrowserFactoryOptions) {
    this.#targetUrl = options.targetUrl;
    this.#launchArgs = browserLaunchArgsForTarget(options.targetUrl);
    this.#credential = options.credential;
    this.#headless = options.headless ?? true;
    this.#executablePath = options.executablePath;
    this.#launch = options.launch ?? chromium.launch.bind(chromium);
  }

  public async open(deadline: Deadline): Promise<BrowserControllerPort> {
    this.#assertDeadline(deadline);
    if (this.#disposed)
      throw new Error("Playwright browser factory is disposed.");
    const budget = createBrowserDeadlineBudget(deadline);
    const contextDeadline = budget.remaining();
    const context = await this.#awaitOperation(
      this.#contextFor(contextDeadline),
      contextDeadline,
    );
    const pageDeadline = budget.remaining();
    const pageOperation = context.newPage();
    let page: Page;
    try {
      page = await this.#awaitOperation(pageOperation, pageDeadline);
    } catch (error) {
      void pageOperation
        .then((latePage) =>
          latePage.close({ runBeforeUnload: false }).catch(() => undefined),
        )
        .catch(() => undefined);
      if (error instanceof BrowserPlaneError) throw error;
      throw this.#failure(
        deadline.signal.aborted ? "CANCELLED" : "DEVICE_UNREACHABLE",
        deadline.signal.aborted ? "none" : "reconnect_then_capture",
      );
    }
    try {
      const navigationDeadline = budget.remaining();
      await this.#awaitOperation(
        page.goto(this.#targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: navigationDeadline.timeoutMs,
        }),
        navigationDeadline,
      );
      const authenticationStateDeadline = budget.remaining();
      await this.#awaitOperation(
        this.#waitForAuthenticationState(page, authenticationStateDeadline),
        authenticationStateDeadline,
      );
      const authenticationDeadline = budget.remaining();
      await this.#awaitOperation(
        this.#authenticateIfRequired(page, authenticationDeadline),
        authenticationDeadline,
      );
      const readyDeadline = budget.remaining();
      await this.#awaitOperation(
        this.#waitForReadyFacade(page, readyDeadline),
        readyDeadline,
      );
      return new BrowserController(page);
    } catch (error) {
      const closeOperation = page.close({ runBeforeUnload: false });
      await this.#waitForCleanup(closeOperation, budget.remaining());
      if (error instanceof BrowserPlaneError) throw error;
      throw this.#failure(
        deadline.signal.aborted ? "CANCELLED" : "DEVICE_UNREACHABLE",
        deadline.signal.aborted ? "none" : "reconnect_then_capture",
      );
    }
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const browser = this.#browser;
    this.#browser = null;
    this.#context = null;
    await browser?.close();
  }

  async #contextFor(deadline: Deadline): Promise<BrowserContext> {
    if (this.#context !== null) return this.#context;
    this.#assertDeadline(deadline);
    const budget = createBrowserDeadlineBudget(deadline);
    const launchDeadline = budget.remaining();
    const launchOperation = this.#launch({
      headless: this.#headless,
      chromiumSandbox: true,
      timeout: launchDeadline.timeoutMs,
      ...(this.#executablePath === undefined
        ? {}
        : { executablePath: this.#executablePath }),
      ...(this.#launchArgs.length === 0 ? {} : { args: [...this.#launchArgs] }),
    });
    let browser: Browser;
    try {
      browser = await this.#awaitOperation(launchOperation, launchDeadline);
    } catch (error) {
      void launchOperation
        .then(
          (lateBrowser) => lateBrowser.close(),
          () => undefined,
        )
        .catch(() => undefined);
      throw error;
    }
    if (this.#disposed || deadline.signal.aborted) {
      await browser.close();
      throw this.#failure("CANCELLED", "none");
    }
    this.#browser = browser;
    const contextDeadline = budget.remaining();
    try {
      this.#context = await this.#awaitOperation(
        browser.newContext({ ignoreHTTPSErrors: false }),
        contextDeadline,
      );
    } catch (error) {
      this.#browser = null;
      await browser.close().catch(() => undefined);
      throw error;
    }
    return this.#context;
  }

  async #waitForAuthenticationState(
    page: Page,
    deadline: Deadline,
  ): Promise<void> {
    this.#assertDeadline(deadline);
    await page.waitForFunction(
      () => {
        const facade = (
          window as unknown as {
            __JETKVM_AUTOMATION__?: { readonly version: unknown };
          }
        ).__JETKVM_AUTOMATION__;
        return (
          facade !== undefined ||
          document.querySelector('input[name="password"]') !== null
        );
      },
      undefined,
      { polling: CONNECT_POLL_MS, timeout: deadline.timeoutMs },
    );
  }

  async #authenticateIfRequired(page: Page, deadline: Deadline): Promise<void> {
    const password = page.locator('input[name="password"]');
    if ((await password.count()) === 0) return;
    await this.#credential.useUtf8(async (value) => {
      await password.fill(value, { timeout: deadline.timeoutMs });
    });
    const form = password.locator("xpath=ancestor::form[1]");
    await form.press("Enter", { timeout: deadline.timeoutMs });
    try {
      await page.waitForURL((url) => url.pathname !== "/login-local", {
        timeout: deadline.timeoutMs,
      });
    } catch {
      throw this.#failure("AUTH_FAILED", "none");
    }
  }

  async #waitForReadyFacade(page: Page, deadline: Deadline): Promise<void> {
    this.#assertDeadline(deadline);
    await page.waitForFunction(
      () => {
        const facade = (
          window as unknown as {
            __JETKVM_AUTOMATION__?: {
              readonly version: unknown;
              snapshot(): { readonly state: unknown };
            };
          }
        ).__JETKVM_AUTOMATION__;
        if (facade?.version !== 1) return false;
        try {
          return facade.snapshot().state === "ready";
        } catch {
          return false;
        }
      },
      undefined,
      { polling: CONNECT_POLL_MS, timeout: deadline.timeoutMs },
    );
  }

  async #waitForCleanup(
    operation: Promise<unknown>,
    deadline: Deadline,
  ): Promise<void> {
    const observed = operation.catch(() => undefined);
    if (deadline.signal.aborted) {
      void observed;
      return;
    }
    const boundary = Promise.withResolvers<void>();
    const onAbort = () => boundary.resolve();
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => boundary.resolve(),
      Math.max(0, deadline.timeoutMs),
    );
    try {
      await Promise.race([observed, boundary.promise]);
    } finally {
      clearTimeout(timer);
      deadline.signal.removeEventListener("abort", onAbort);
      void observed;
    }
  }

  async #awaitOperation<T>(
    operation: Promise<T>,
    deadline: Deadline,
  ): Promise<T> {
    if (deadline.signal.aborted) {
      void operation.catch(() => undefined);
      throw this.#failure("CANCELLED", "none");
    }
    const cancellation = Promise.withResolvers<never>();
    const onAbort = () => {
      cancellation.reject(this.#failure("CANCELLED", "none"));
    };
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([operation, cancellation.promise]);
    } finally {
      deadline.signal.removeEventListener("abort", onAbort);
      void operation.catch(() => undefined);
    }
  }

  #assertDeadline(deadline: Deadline): void {
    if (
      deadline.signal.aborted ||
      !Number.isSafeInteger(deadline.timeoutMs) ||
      deadline.timeoutMs < 1 ||
      deadline.timeoutMs > 60_000
    ) {
      throw this.#failure(
        deadline.signal.aborted ? "CANCELLED" : "CONFIG_INVALID",
        "none",
      );
    }
  }

  #failure(
    code: "AUTH_FAILED" | "CANCELLED" | "CONFIG_INVALID" | "DEVICE_UNREACHABLE",
    requiredNextStep: "none" | "reconnect_then_capture",
  ): BrowserPlaneError {
    return new BrowserPlaneError({
      code,
      outcome: "not_sent",
      stage: "admission",
      writeBegan: false,
      acknowledged: false,
      dispatchedCount: 0,
      completedCount: 0,
      requestedCount: 0,
      safeToRetry: code === "DEVICE_UNREACHABLE",
      requiredNextStep,
      suffixSuppressed: false,
    });
  }
}
