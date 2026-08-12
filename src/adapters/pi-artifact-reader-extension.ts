export const PI_ARTIFACT_READ_TOOL = 'agentknot_artifact_read';
export const PI_ARTIFACT_READ_PROTOCOL = 'agentknot-artifact-read-v1';

interface PiExtensionApi {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    parameters: Record<string, unknown>;
    execute: () => Promise<{
      content: Array<{ type: 'text'; text: string }>;
      details: Record<string, unknown>;
      isError?: boolean;
    }>;
  }): void;
}

function artifactReaderExtension(pi: PiExtensionApi): void {
  let consumed = false;
  pi.registerTool({
    name: PI_ARTIFACT_READ_TOOL,
    label: 'Read AgentKnot artifact',
    description: 'Read the one exact git-patch artifact authorized for this Job. The grant is single-use and exposes no filesystem path.',
    promptSnippet: 'Read the exact AgentKnot-authorized patch artifact for this Job',
    promptGuidelines: [
      `Use ${PI_ARTIFACT_READ_TOOL} once before assessing the authorized patch; it accepts no paths, URLs, or content arguments.`,
    ],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      if (consumed) {
        return {
          content: [{ type: 'text', text: 'Artifact read grant already consumed.' }],
          details: { status: 'budget-exhausted', bytes: 0 },
          isError: true,
        };
      }
      consumed = true;
      if (typeof process.send !== 'function') {
        return {
          content: [{ type: 'text', text: 'AgentKnot artifact channel is unavailable.' }],
          details: { status: 'unavailable', bytes: 0 },
          isError: true,
        };
      }
      const requestId = 'artifact-read-1';
      const response = await new Promise<unknown>((resolve, reject) => {
        const onMessage = (message: unknown): void => {
          if (
            typeof message !== 'object' ||
            message === null ||
            Array.isArray(message) ||
            !('protocol' in message) ||
            message.protocol !== PI_ARTIFACT_READ_PROTOCOL ||
            !('requestId' in message) ||
            message.requestId !== requestId
          ) return;
          process.off('message', onMessage);
          resolve(message);
        };
        process.on('message', onMessage);
        process.send!({
          protocol: PI_ARTIFACT_READ_PROTOCOL,
          schemaVersion: 1,
          action: 'read',
          requestId,
        }, (error) => {
          if (error === null) return;
          process.off('message', onMessage);
          reject(error);
        });
      });
      if (typeof response !== 'object' || response === null || Array.isArray(response)) {
        throw new Error('AgentKnot artifact response is invalid');
      }
      const result = response as {
        ok?: unknown;
        sourceJobId?: unknown;
        attempt?: unknown;
        size?: unknown;
        sha256?: unknown;
        content?: unknown;
      };
      if (result.ok !== true) {
        return {
          content: [{ type: 'text', text: 'AgentKnot refused the artifact read.' }],
          details: { status: 'refused', bytes: 0 },
          isError: true,
        };
      }
      if (
        typeof result.sourceJobId !== 'string' ||
        !Number.isSafeInteger(result.attempt) ||
        !Number.isSafeInteger(result.size) ||
        typeof result.sha256 !== 'string' ||
        typeof result.content !== 'string' ||
        Buffer.byteLength(result.content, 'utf8') !== result.size
      ) throw new Error('AgentKnot artifact response fields are invalid');
      return {
        content: [{ type: 'text', text: result.content }],
        details: {
          status: 'served',
          sourceJobId: result.sourceJobId,
          attempt: result.attempt,
          sha256: result.sha256,
          bytes: result.size,
        },
      };
    },
  });
}

/** Loaded into broker memory, then materialized beside each private attempt bundle. */
export const PI_ARTIFACT_READ_EXTENSION_SOURCE = [
  `const PI_ARTIFACT_READ_TOOL = ${JSON.stringify(PI_ARTIFACT_READ_TOOL)};`,
  `const PI_ARTIFACT_READ_PROTOCOL = ${JSON.stringify(PI_ARTIFACT_READ_PROTOCOL)};`,
  `export default ${artifactReaderExtension.toString()};`,
  '',
].join('\n');
