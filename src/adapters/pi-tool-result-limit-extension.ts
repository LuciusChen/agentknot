import { PI_ARTIFACT_READ_TOOL } from './pi-artifact-reader-extension.js';

export const PI_TOOL_RESULT_MAX_BYTES = 8 * 1024;

interface PiToolResultEvent {
  toolName?: unknown;
  content?: unknown;
  details?: unknown;
}

interface PiToolResultPatch {
  content: unknown[];
  details: Record<string, unknown>;
}

interface PiExtensionApi {
  on(
    event: 'tool_result',
    handler: (value: PiToolResultEvent) => PiToolResultPatch | undefined
  ): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8Head(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

export function limitPiToolResult(event: PiToolResultEvent): PiToolResultPatch | undefined {
  if (event.toolName === PI_ARTIFACT_READ_TOOL || !Array.isArray(event.content)) return undefined;
  const textEntries = event.content
    .map((item, index) => ({ item, index }))
    .filter(
      (entry): entry is { item: Record<string, unknown> & { type: 'text'; text: string }; index: number } =>
        isRecord(entry.item) && entry.item.type === 'text' && typeof entry.item.text === 'string'
    );
  if (textEntries.length === 0 || textEntries.length !== event.content.length) return undefined;

  const entry = textEntries[0];
  if (entry === undefined) return undefined;
  const { item, index } = entry;
  const originalText = textEntries.map((candidate) => candidate.item.text).join('\n');
  const originalBytes = Buffer.byteLength(originalText, 'utf8');
  if (originalBytes <= PI_TOOL_RESULT_MAX_BYTES) return undefined;

  const retained = event.toolName === 'bash' ? 'tail' : 'head';
  const marker = retained === 'tail'
    ? `[AgentKnot limited this tool result from ${originalBytes} to ${PI_TOOL_RESULT_MAX_BYTES} UTF-8 bytes. Showing the tail; narrow the query or request a targeted range.]\n\n`
    : `\n\n[AgentKnot limited this tool result from ${originalBytes} to ${PI_TOOL_RESULT_MAX_BYTES} UTF-8 bytes. Narrow the query or request a targeted range.]`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const contentBudget = Math.max(0, PI_TOOL_RESULT_MAX_BYTES - markerBytes);
  const limitedText = retained === 'tail'
    ? `${marker}${utf8Tail(originalText, contentBudget)}`
    : `${utf8Head(originalText, contentBudget)}${marker}`;
  const textIndexes = new Set(textEntries.map((candidate) => candidate.index));
  const content = event.content.flatMap((candidate, candidateIndex) => {
    if (candidateIndex === index) return [{ ...item, text: limitedText }];
    return textIndexes.has(candidateIndex) ? [] : [candidate];
  });
  return {
    content,
    details: {
      ...(isRecord(event.details) ? event.details : {}),
      agentknotToolResultLimit: {
        originalBytes,
        maxBytes: PI_TOOL_RESULT_MAX_BYTES,
        retained,
      },
    },
  };
}

function piToolResultLimitExtension(pi: PiExtensionApi): void {
  pi.on('tool_result', (event) => limitPiToolResult(event));
}

/** Loaded from broker memory into one private normal-run Pi extension bundle. */
export const PI_TOOL_RESULT_LIMIT_EXTENSION_SOURCE = [
  `const PI_ARTIFACT_READ_TOOL = ${JSON.stringify(PI_ARTIFACT_READ_TOOL)};`,
  `const PI_TOOL_RESULT_MAX_BYTES = ${String(PI_TOOL_RESULT_MAX_BYTES)};`,
  isRecord.toString(),
  utf8Head.toString(),
  utf8Tail.toString(),
  limitPiToolResult.toString(),
  `export default ${piToolResultLimitExtension.toString()};`,
  '',
].join('\n');
