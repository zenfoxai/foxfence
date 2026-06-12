import { loadConfig, ConfigError } from "./config/load.ts";
import { createServer } from "./server.ts";

function configPath(argv: string[]): string {
  const flag = argv.findIndex((a) => a === "--config" || a === "-c");
  if (flag !== -1) {
    const value = argv[flag + 1];
    if (!value) {
      console.error("error: --config requires a path");
      process.exit(2);
    }
    return value;
  }
  return "./foxfence.yaml";
}

const path = configPath(process.argv.slice(2));

try {
  const config = await loadConfig(path);
  const server = createServer(config);
  console.log(`foxfence listening on http://${server.hostname}:${server.port}`);
  console.log(
    `models: ${config.models.map((m) => `${m.expose} → ${m.upstream}/${m.model}`).join(", ")}`,
  );
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`foxfence: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
