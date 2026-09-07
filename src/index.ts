import app from "./app";
import { startBot } from "./discord/client";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Node's Server.listen callback never receives an error argument — real
// bind failures (e.g. EADDRINUSE) are emitted as an 'error' event instead,
// which must be listened for separately or it crashes the process uncaught.
const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");
});
server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

void startBot().catch((error) => {
  logger.error({ err: error }, "Jarvis failed to connect to Discord");
});
