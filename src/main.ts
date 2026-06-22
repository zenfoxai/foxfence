import { loadConfig } from "./config/load.ts";
import { createServer } from "./server.ts";
import pkg from "../package.json" with { type: "json" };

const argv = process.argv.slice(2);

if (argv.includes("--version") || argv.includes("-v")) {
  console.log(`foxfence ${pkg.version}`);
  process.exit(0);
}
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    `foxfence ${pkg.version} — model reliability & safety module for agents\n\n` +
      `Usage: foxfence [--config <path>]\n\n` +
      `  -c, --config <path>   config file (default: ./foxfence.yaml)\n` +
      `  -v, --version         print version and exit\n` +
      `  -h, --help            print this help and exit`,
  );
  process.exit(0);
}

function configPath(args: string[]): string {
  const flag = args.findIndex((a) => a === "--config" || a === "-c");
  if (flag !== -1) {
    const value = args[flag + 1];
    if (!value) {
      console.error("error: --config requires a path");
      process.exit(2);
    }
    return value;
  }
  return "./foxfence.yaml";
}

const path = configPath(argv);

try {
  const config = await loadConfig(path);
  const server = createServer(config);
  console.log(`foxfence listening on http://${server.hostname}:${server.port}`);
  console.log(
    `models: ${config.models.map((m) => `${m.expose} → ${m.upstream}/${m.model}`).join(", ")}`,
  );
} catch (e) {
  // Startup failures (bad config, unwritable audit path, invalid policy
  // pattern, bad listen address) are operational, not bugs — surface a clean
  // message and exit, never a raw stack trace. ConfigError is just the most
  // common case.
  console.error(`foxfence: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
