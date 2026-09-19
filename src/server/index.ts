import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
const config = loadConfig();
const service = createApp(config);
const server = service.app.listen(config.PORT, "127.0.0.1", () =>
  console.log(`CUA Parse: ${config.APP_BASE_URL}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    server.close(() => {
      void service.close().then(() => process.exit(0));
    });
  });
