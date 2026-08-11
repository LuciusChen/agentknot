import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { ServiceHost, type ServiceDefinition, type ServiceStatus } from './service-host.js';

export interface ServiceCommandOptions {
  readonly configPath?: string;
  readonly serviceHost?: ServiceHost;
}

export type ServiceOperationResult =
  | {
      readonly operation: 'install' | 'start' | 'stop' | 'restart' | 'uninstall';
      readonly definitionPath: string;
    }
  | {
      readonly operation: 'status';
      readonly definitionPath: string;
      readonly status: ServiceStatus;
    };

type ServiceOperation = ServiceOperationResult['operation'];

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function defaultCliEntryPath(): string {
  return fileURLToPath(new URL('./cli.js', import.meta.url));
}

export async function dispatchServiceCommand(
  argv: readonly string[],
  options: ServiceCommandOptions = {}
): Promise<ServiceOperationResult> {
  const args = [...argv];
  const operation = args.shift();
  if (!['install', 'start', 'stop', 'restart', 'status', 'uninstall'].includes(operation ?? '')) {
    throw new Error('service requires install, start, stop, restart, status, or uninstall');
  }
  const serviceOperation = operation as ServiceOperation;
  const service = options.serviceHost ?? new ServiceHost();
  if (serviceOperation === 'install') {
    const host = takeOption(args, '--host') ?? '127.0.0.1';
    const port = Number(takeOption(args, '--port') ?? '7391');
    const executionPath = takeOption(args, '--path') ?? process.env.PATH ?? '';
    if (args.length > 0) throw new Error(`Unknown service option: ${args.join(' ')}`);
    const loaded = await loadConfig(
      options.configPath ?? process.env.AGENTKNOT_CONFIG ?? 'agentknot.config.json'
    );
    const definition: ServiceDefinition = {
      nodeExecutable: path.resolve(process.execPath),
      cliEntryPath: path.resolve(defaultCliEntryPath()),
      configPath: loaded.path,
      executionPath,
      host,
      port,
    };
    const installed = await service.install(definition);
    return { operation: serviceOperation, definitionPath: installed.definitionPath };
  }
  if (args.length > 0) throw new Error(`Unknown service option: ${args.join(' ')}`);
  if (serviceOperation === 'status') {
    const status = await service.status();
    return { operation: serviceOperation, definitionPath: status.definitionPath, status };
  }
  if (serviceOperation === 'start') await service.start();
  else if (serviceOperation === 'stop') await service.stop();
  else if (serviceOperation === 'restart') await service.restart();
  else await service.uninstall();
  return { operation: serviceOperation, definitionPath: service.paths.definitionPath };
}

export function formatServiceResult(result: ServiceOperationResult, json: boolean): string {
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  if (result.operation === 'status') {
    return `AgentKnot service: ${result.status.state} (${result.definitionPath})\n`;
  }
  return `AgentKnot service ${result.operation}: ${result.definitionPath}\n`;
}
