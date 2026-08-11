import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { readBrokerStatus, startBroker } from './broker-lifecycle.js';
import { readBrokerLaunchProfile } from './broker-profile.js';
import { validateTaskAssessment } from './delegation-policy.js';
import { AgentKnotHttpClient } from './http-client.js';
import { readLocalDiscovery } from './local-discovery.js';
import { buildOrchestrationHandoff } from './orchestration-handoff.js';

const text = z.string().min(1).max(64 * 1024);
const shortText = z.string().min(1).max(1_000);
const taskContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: z.string().min(1).max(1_000),
    relevantPaths: z.array(z.string().min(1).max(500)).max(20),
    constraints: z.array(z.string().min(1).max(500)).max(20),
  })
  .strict();
const assessmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    recommendation: z.enum(['delegate', 'do-not-delegate']),
    complexity: z.enum(['low', 'medium', 'high']),
    parallelizable: z.boolean(),
    taskKinds: z.array(shortText).max(20),
    reasoning: text,
    context: taskContextSchema.optional(),
    subtasks: z
      .array(
        z
          .object({
            title: text,
            kind: shortText,
            prompt: text,
            acceptanceCriteria: z.array(text).min(1).max(20),
          })
          .strict()
      )
      .max(20),
  })
  .strict();

const orchestrationIdSchema = z.object({ id: shortText }).strict();
const orchestrationFollowSchema = z
  .object({ id: shortText, afterSequence: z.number().int().nonnegative().default(0) })
  .strict();
const cliEntryPath = fileURLToPath(new URL('./cli.js', import.meta.url));

function jsonResult(value: object) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

async function withErrors(operation: () => Promise<object>) {
  try {
    return jsonResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}

async function resolveBrokerClient(): Promise<AgentKnotHttpClient> {
  const configured = process.env.AGENTKNOT_SERVER_URL;
  if (configured !== undefined) {
    if (configured.trim() === '') throw new Error('AGENTKNOT_SERVER_URL must not be empty');
    return new AgentKnotHttpClient(configured);
  }
  const record = await readLocalDiscovery();
  if (record === undefined) {
    throw new Error('AgentKnot broker is not running; start it explicitly with `agentknot broker up`');
  }
  return new AgentKnotHttpClient(record.url);
}

export function createAgentKnotMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'agentknot', version: '0.0.1' },
    {
      capabilities: { tools: {} },
      instructions:
        'AgentKnot is controller-neutral orchestration middleware. The controller owns planning, task assessment, acceptance, and artifact promotion. If the broker is stopped or unavailable and a launch profile is configured, explicitly try agentknot_broker_start once. Submit only a controller-authored assessment, follow durable work by sequence cursor, and inspect evidence without making transport state authoritative.',
    }
  );

  server.registerTool(
    'agentknot_broker_status',
    {
      title: 'AgentKnot broker status',
      description: 'Read the independent local AgentKnot broker status without creating a runtime.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    async () =>
      withErrors(async () => {
        const [status, profile] = await Promise.all([
          readBrokerStatus(),
          readBrokerLaunchProfile(),
        ]);
        return { ...status, launchConfigured: profile !== undefined };
      })
  );

  server.registerTool(
    'agentknot_broker_start',
    {
      title: 'Start AgentKnot broker',
      description:
        'Explicitly start the independent local broker from the product-owned launch profile. Never scans the target repository or installs an OS service.',
      inputSchema: z.object({}).strict(),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async () =>
      withErrors(async () => {
        if (process.env.AGENTKNOT_SERVER_URL !== undefined) {
          throw new Error('Cannot start a local broker while AGENTKNOT_SERVER_URL selects an explicit server');
        }
        const profile = await readBrokerLaunchProfile();
        if (profile === undefined) {
          throw new Error(
            'AgentKnot broker launch is not configured; run `agentknot broker up --config <path>` once'
          );
        }
        return startBroker({
          cliEntryPath,
          configPath: profile.configPath,
          port: profile.port,
        });
      })
  );

  server.registerTool(
    'agentknot_delegation_policy',
    {
      title: 'AgentKnot delegation policy',
      description: 'Read the broker delegation policy before the controller constructs its assessment.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    async () => withErrors(async () => ({ delegation: await (await resolveBrokerClient()).delegationPolicy() }))
  );

  server.registerTool(
    'agentknot_routes',
    {
      title: 'AgentKnot routes',
      description: 'List configured replaceable worker/provider/model routes from the broker.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    async () => withErrors(async () => ({ routes: await (await resolveBrokerClient()).routes() }))
  );

  server.registerTool(
    'agentknot_orchestration_start',
    {
      title: 'Start AgentKnot orchestration',
      description:
        'Submit one bounded controller-authored orchestration assessment. This admits work but does not apply artifacts.',
      inputSchema: z
        .object({
          prompt: text,
          workspace: text,
          source: shortText,
          delegation: z.enum(['inherit', 'never', 'suggest', 'force']).default('inherit'),
          assessment: assessmentSchema,
          idempotencyKey: shortText.optional(),
        })
        .strict(),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ prompt, workspace, source, delegation, assessment, idempotencyKey }) =>
      withErrors(async () => {
        const client = await resolveBrokerClient();
        const orchestration = await client.startOrchestration({
          prompt,
          workspace,
          source,
          delegation,
          assessment: validateTaskAssessment(assessment),
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
        return buildOrchestrationHandoff(client, orchestration);
      })
  );

  server.registerTool(
    'agentknot_orchestration_status',
    {
      title: 'AgentKnot orchestration status',
      description:
        'Read one durable orchestration and compact artifact evidence. This call is non-blocking.',
      inputSchema: orchestrationIdSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ id }) =>
      withErrors(async () => {
        const client = await resolveBrokerClient();
        const orchestration = await client.getOrchestration(id);
        if (orchestration === undefined) throw new Error(`Orchestration not found: ${id}`);
        return buildOrchestrationHandoff(client, orchestration);
      })
  );

  server.registerTool(
    'agentknot_orchestration_follow',
    {
      title: 'Follow AgentKnot orchestration',
      description:
        'Wait for the next durable orchestration event batch after a sequence cursor. Returns after activity, terminal completion, or a bounded heartbeat; reconnect with nextSequence.',
      inputSchema: orchestrationFollowSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ id, afterSequence }) =>
      withErrors(async () => {
        const client = await resolveBrokerClient();
        const batch = await client.followOrchestration(id, afterSequence);
        if (batch.record !== undefined) {
          return {
            nextSequence: batch.nextSequence,
            terminal: await buildOrchestrationHandoff(client, batch.record),
          };
        }
        return {
          nextSequence: batch.nextSequence,
          events: batch.events,
          ...(batch.progress === undefined ? {} : { progress: batch.progress }),
        };
      })
  );

  server.registerTool(
    'agentknot_orchestration_cancel',
    {
      title: 'Cancel AgentKnot orchestration',
      description: 'Request cancellation of one exact durable orchestration.',
      inputSchema: orchestrationIdSchema,
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) =>
      withErrors(async () => {
        await (await resolveBrokerClient()).cancelOrchestration(id);
        return { accepted: true, orchestrationId: id };
      })
  );

  server.registerTool(
    'agentknot_artifact_preview',
    {
      title: 'Preview AgentKnot artifact',
      description: 'Read one worker patch artifact without applying or promoting it.',
      inputSchema: z
        .object({ jobId: shortText, attempt: z.number().int().positive() })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ jobId, attempt }) =>
      withErrors(async () => {
        const preview = await (await resolveBrokerClient()).previewArtifact(jobId, attempt);
        if (preview === undefined) throw new Error(`Artifact not found: ${jobId} attempt ${attempt}`);
        return preview;
      })
  );

  return server;
}

export function serveAgentKnotMcp(): StdioServerHandle {
  return serveStdio(() => createAgentKnotMcpServer(), {
    onerror(error) {
      process.stderr.write(`agentknot mcp: ${error.message}\n`);
    },
  });
}
