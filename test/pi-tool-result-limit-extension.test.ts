import assert from 'node:assert/strict';
import test from 'node:test';

import { PI_ARTIFACT_READ_TOOL } from '../src/adapters/pi-artifact-reader-extension.js';
import {
  PI_TOOL_RESULT_LIMIT_EXTENSION_SOURCE,
  PI_TOOL_RESULT_MAX_BYTES,
  limitPiToolResult,
} from '../src/adapters/pi-tool-result-limit-extension.js';

function textFrom(patch: ReturnType<typeof limitPiToolResult>): string {
  const item = patch?.content[0];
  assert.ok(typeof item === 'object' && item !== null && 'text' in item);
  assert.equal(typeof item.text, 'string');
  return item.text as string;
}

test('Pi tool-result limit keeps a UTF-8-safe head for read-like tools', () => {
  const original = `HEAD\n${'🙂search-result\n'.repeat(1_000)}TAIL`;
  const patch = limitPiToolResult({
    toolName: 'read',
    content: [{ type: 'text', text: original }],
    details: { original: true },
  });
  const text = textFrom(patch);

  assert.ok(text.startsWith('HEAD\n'));
  assert.match(text, /AgentKnot limited this tool result/u);
  assert.doesNotMatch(text, /�/u);
  assert.ok(Buffer.byteLength(text, 'utf8') <= PI_TOOL_RESULT_MAX_BYTES);
  assert.deepEqual(patch?.details, {
    original: true,
    agentknotToolResultLimit: {
      originalBytes: Buffer.byteLength(original, 'utf8'),
      maxBytes: PI_TOOL_RESULT_MAX_BYTES,
      retained: 'head',
    },
  });
});

test('Pi tool-result limit keeps the UTF-8-safe tail of bash output', () => {
  const first = `HEAD\n${'🙂command-output\n'.repeat(500)}`;
  const second = `${'more-output\n'.repeat(500)}TAIL`;
  const original = `${first}\n${second}`;
  const patch = limitPiToolResult({
    toolName: 'bash',
    content: [
      { type: 'text', text: first },
      { type: 'text', text: second },
    ],
  });
  const text = textFrom(patch);

  assert.equal(patch?.content.length, 1);
  assert.match(text, /^\[AgentKnot limited this tool result/u);
  assert.ok(text.endsWith('TAIL'));
  assert.doesNotMatch(text, /�/u);
  assert.ok(Buffer.byteLength(text, 'utf8') <= PI_TOOL_RESULT_MAX_BYTES);
  assert.deepEqual(patch?.details.agentknotToolResultLimit, {
    originalBytes: Buffer.byteLength(original, 'utf8'),
    maxBytes: PI_TOOL_RESULT_MAX_BYTES,
    retained: 'tail',
  });
});

test('Pi tool-result limit leaves bounded and exact artifact results unchanged', () => {
  assert.equal(
    limitPiToolResult({
      toolName: 'read',
      content: [{ type: 'text', text: 'bounded result' }],
    }),
    undefined
  );
  assert.equal(
    limitPiToolResult({
      toolName: PI_ARTIFACT_READ_TOOL,
      content: [{ type: 'text', text: 'x'.repeat(PI_TOOL_RESULT_MAX_BYTES + 1) }],
    }),
    undefined
  );
  assert.equal(
    limitPiToolResult({
      toolName: 'read',
      content: [
        { type: 'text', text: 'x'.repeat(PI_TOOL_RESULT_MAX_BYTES + 1) },
        { type: 'image', data: 'image-data', mimeType: 'image/png' },
      ],
    }),
    undefined
  );
});

test('generated Pi extension source installs the same result limiter', async () => {
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(PI_TOOL_RESULT_LIMIT_EXTENSION_SOURCE).toString('base64')}`
  ) as { default: (pi: { on: (type: string, handler: (event: unknown) => unknown) => void }) => void };
  let handler: ((event: unknown) => unknown) | undefined;
  module.default({
    on(type, value) {
      assert.equal(type, 'tool_result');
      handler = value;
    },
  });
  assert.ok(handler);
  const patch = handler({
    toolName: 'grep',
    content: [{ type: 'text', text: 'x'.repeat(PI_TOOL_RESULT_MAX_BYTES + 1) }],
  }) as ReturnType<typeof limitPiToolResult>;
  assert.ok(Buffer.byteLength(textFrom(patch), 'utf8') <= PI_TOOL_RESULT_MAX_BYTES);
});
