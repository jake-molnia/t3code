import * as Layer from "effect/Layer";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HtmlRender from "../../htmlRender/HtmlRender.ts";
import * as Broker from "../../mcp/PreviewAutomationBroker.ts";
import * as DesktopBrowserChannel from "../../preview/DesktopBrowserChannel.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import * as ServerBrowser from "../../preview/ServerBrowser.ts";

export const layer = Layer.merge(ServerBrowser.layer, HtmlRender.layer).pipe(
  Layer.provideMerge(PreviewManager.layer),
  Layer.provideMerge(Broker.layer),
  Layer.provideMerge(PreviewBrowser.layer),
  Layer.provide(DesktopBrowserChannel.layer),
  Layer.provideMerge(ServerEnvironment.layer),
);
