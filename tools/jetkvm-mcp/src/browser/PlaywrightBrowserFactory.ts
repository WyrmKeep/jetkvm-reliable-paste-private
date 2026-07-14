import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import type { Deadline } from "../device/DeviceRpcAdapter.js";
import { BrowserPlaneError } from "./bridgeProtocol.js";
import { BrowserController, type BrowserControllerPort } from "./BrowserController.js";
import type { BrowserControllerFactory } from "./ManagedBrowserController.js";
import type { DisposableSecret } from "./auth.js";

const CONNECT_POLL_MS = 100;

export interface PlaywrightBrowserFactoryOptions {
  readonly targetUrl: string;
  readonly credential: DisposableSecret;
  readonly headless?: boolean;
  readonly launch?: typeof chromium.launch;
}

export class PlaywrightBrowserFactory implements BrowserControllerFactory {
  readonly #targetUrl: string;
  readonly #credential: DisposableSecret;
  readonly #headless: boolean;
  readonly #launch: typeof chromium.launch;
  #browser: Browser | null = null;
  #context: BrowserContext | null = null;
  #disposed = false;

  public constructor(options: PlaywrightBrowserFactoryOptions) {
    this.#targetUrl = options.targetUrl;
    this.#credential = options.credential;
    this.#headless = options.headless ?? true;
    this.#launch = options.launch ?? chromium.launch.bind(chromium);
  }

  public async open(deadline: Deadline): Promise<BrowserControllerPort> {
    this.#assertDeadline(deadline);
    if (this.#disposed) throw new Error("Playwright browser factory is disposed.");
    const context = await this.#contextFor(deadline);
    const page = await context.newPage();
    try {
      await page.goto(this.#targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: deadline.timeoutMs,
      });
      await this.#waitForAuthenticationState(page, deadline);
      await this.#authenticateIfRequired(page, deadline);
      await this.#waitForReadyFacade(page, deadline);
      return new BrowserController(page);
    } catch (error) {
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
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
    const browser = await this.#launch({ headless: this.#headless });
    if (this.#disposed || deadline.signal.aborted) {
      await browser.close();
      throw this.#failure("CANCELLED", "none");
    }
    this.#browser = browser;
    this.#context = await browser.newContext({ ignoreHTTPSErrors: false });
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
      await page.waitForURL(
        (url) => url.pathname !== "/login-local",
        { timeout: deadline.timeoutMs },
      );
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
    code:
      | "AUTH_FAILED"
      | "CANCELLED"
      | "CONFIG_INVALID"
      | "DEVICE_UNREACHABLE",
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
