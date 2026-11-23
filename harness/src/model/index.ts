import { FileCallLogger, type CallLogger } from "./callLog.ts";
import { loadModelsConfig, type ModelsConfig } from "./config.ts";
import { haikuCliInvoker } from "./haikuCli.ts";
import { LoggedModelPort } from "./loggedPort.ts";
import { lunaCliInvoker } from "./lunaCli.ts";
import { paths } from "../paths.ts";
import type { ModelPort, PortName } from "./types.ts";

export * from "./types.ts";

/** Build a CLI-backed ModelPort for an explicit model id. */
export function createCliPort(port: PortName, modelId: string, logger: CallLogger = new FileCallLogger(paths.callLogDir)): ModelPort {
  const invoker = port === "haiku" ? haikuCliInvoker(modelId) : lunaCliInvoker(modelId);
  return new LoggedModelPort(port, modelId, invoker, logger);
}

/** Build the ModelPort for the adopted model id in harness/config/models.json. */
export function getModelPort(port: PortName, config: ModelsConfig = loadModelsConfig()): ModelPort {
  return createCliPort(port, config.adopted[port]);
}
