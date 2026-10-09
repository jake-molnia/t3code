// @effect-diagnostics nodeBuiltinImport:off - Owns Playwright resources outside the Effect runtime.
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import type { Browser, BrowserContext } from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

interface Options {
  readonly profilesDir: string;
  /** The runtime owns this browser and its desktop profile. */
  readonly cdpEndpoint?: string;
  /** The image's browser executable when no runtime-owned CDP endpoint is supplied. */
  readonly executable: () => Promise<string>;
  /** Replaces a failed launch's error with the host setup it is missing, if any. */
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onContextClose?: (context: BrowserContext) => void;
}

/** Persistent human profiles keep their storage; isolated agents share a browser, never a context. */
export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  /** Profile clears in progress; a context for that profile opens after its storage is gone. */
  private readonly clearing = new Map<string, Promise<void>>();
  private browser: Promise<Browser> | undefined;
  private closing: Promise<void> | undefined;

  constructor(options: Options) {
    this.options = options;
  }

  private async launchOptions() {
    const executablePath = await this.options.executable();
    const env = this.options.env ?? process.env;
    return {
      executablePath,
      env,
      args: ["--disable-gpu", "--force-device-scale-factor=2"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(options: { readonly executablePath: string }, start: () => Promise<A>) {
    try {
      return await start();
    } catch (cause) {
      throw (await this.options.diagnose?.(options.executablePath, cause)) ?? cause;
    }
  }

  private sharedBrowser() {
    if (!this.browser) {
      const launched = (async () => {
        const { chromium } = loadPlaywright();
        const browser = this.options.cdpEndpoint
          ? await chromium.connectOverCDP(this.options.cdpEndpoint, { timeout: 15_000 })
          : await this.launchOptions().then((options) =>
              this.launch(options, () => chromium.launch(options)),
            );
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      })();
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  contextFor(profileId: string, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() => this.createContext(profileId, isolationKey))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        if (!this.options.cdpEndpoint)
          for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          if (!this.options.cdpEndpoint) await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey?: string) {
    if (this.options.cdpEndpoint) {
      const context = (await this.sharedBrowser()).contexts()[0];
      if (!context) throw new Error("The sandbox desktop browser has no default context.");
      return context;
    }
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      const browser = await this.sharedBrowser();
      return browser.newContext(contextOptions);
    }
    const directory = this.profileDirectory(profileId);
    const options = await this.launchOptions();
    const { chromium } = loadPlaywright();
    await NodeFSP.mkdir(directory, { recursive: true });
    return this.launch(options, () =>
      chromium.launchPersistentContext(directory, { ...options, ...contextOptions }),
    );
  }

  private profileDirectory(profileId: string) {
    const encoded = encodeURIComponent(profileId);
    return NodePath.join(
      this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  /** A throwaway page in the shared browser, for work that must not touch a tab's own storage. */
  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await (await this.sharedBrowser()).newContext();
    const page = await context.newPage();
    page.once("close", () => void context.close().catch(constVoid));
    return page;
  }

  /**
   * Drives a page the desktop app renders, through the CDP endpoint its relay
   * serves. The page keeps the desktop's storage, size, and window.
   */
  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  /** Closes a human profile's persistent context, ending its tabs, then deletes its storage. */
  async clearProfile(profileId: string) {
    if (this.options.cdpEndpoint)
      throw new Error("The sandbox runtime owns the desktop browser profile.");
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const key = JSON.stringify([profileId, null]);
    const clearing = (async () => {
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    await Promise.allSettled(
      [...this.contexts.values()].map(async (pending) => {
        const context = await pending;
        if (!this.options.cdpEndpoint) await context.close();
      }),
    );
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    this.contexts.clear();
  }
}
