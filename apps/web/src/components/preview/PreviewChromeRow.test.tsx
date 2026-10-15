// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PreviewChromeRow } from "./PreviewChromeRow";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each(["", "https://previous.test/"])(
  "keeps the submitted URL visible while navigating from %s",
  async (initialUrl) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (url: string, loading = false) =>
      root.render(
        <PreviewChromeRow
          url={url}
          loading={loading}
          canGoBack={false}
          canGoForward={false}
          refreshDisabled={true}
          onBack={() => {}}
          onForward={() => {}}
          onRefresh={() => {}}
          onSubmit={() => {}}
        />,
      );
    try {
      await act(async () => {
        render(initialUrl);
      });
      const input = container.querySelector("input");
      if (!input) throw new Error("Missing address bar");
      await act(async () => {
        input.focus();
      });
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          "https://example.com",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      expect(document.activeElement).not.toBe(input);
      expect(input.value).toBe("https://example.com");
      await act(async () => {
        render(initialUrl);
      });
      expect(input.value).toBe("https://example.com");
      await act(async () => {
        render(initialUrl, true);
      });
      expect(input.value).toBe("https://example.com");
      await act(async () => {
        render(initialUrl, false);
      });
      expect(input.value).toBe("https://example.com");
      await act(async () => {
        render("https://example.com/");
      });
      expect(input.value).toBe("https://example.com/");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  },
);
