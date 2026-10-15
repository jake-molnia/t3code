import { useSyncExternalStore } from "react";

import { isElectron } from "~/env";

import { isMacPlatform } from "./utils";
// The workspace topbar the desktop app centers the traffic lights in. macOS has
// no overlay API to measure, and the lights stay inside it at any zoom level.
const MACOS_TITLEBAR_HEIGHT = 52;

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
  addEventListener(type: "geometrychange", listener: EventListener): void;
  removeEventListener(type: "geometrychange", listener: EventListener): void;
}

interface NavigatorWithWindowControlsOverlay extends Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlayLike;
}

function getWindowControlsOverlay(): WindowControlsOverlayLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  return (navigator as NavigatorWithWindowControlsOverlay).windowControlsOverlay ?? null;
}

function subscribeTitlebarArea(listener: () => void): () => void {
  const overlay = getWindowControlsOverlay();
  overlay?.addEventListener("geometrychange", listener);
  return () => overlay?.removeEventListener("geometrychange", listener);
}

function getNativeTitlebarHeight(): number {
  if (isElectron && isMacPlatform(navigator.platform)) return MACOS_TITLEBAR_HEIGHT;
  const overlay = getWindowControlsOverlay();
  return overlay?.visible ? overlay.getTitlebarAreaRect().bottom : 0;
}

/** Height of the strip at the top of the window where native window controls paint over the page. */
export function useNativeTitlebarHeight(): number {
  return useSyncExternalStore(subscribeTitlebarArea, getNativeTitlebarHeight, () => 0);
}
