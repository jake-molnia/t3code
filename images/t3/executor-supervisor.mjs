import { startServer } from "./apps/host-selfhost/dist-server/serve.js";

// Exit with the central process, including when it was killed without finalizers.
const parent = process.ppid;
const parentWatch = setInterval(() => {
  if (process.ppid !== parent) process.exit(1);
}, 1000);
parentWatch.unref();
await startServer();
