import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { mapCodexModels, readCodexModelsFromAppServer } from './models.js';

describe('mapCodexModels', () => {
  it('uses the runtime model field and preserves effort metadata', () => {
    expect(mapCodexModels([
      {
        model: 'gpt-current-codex',
        displayName: 'GPT Codex',
        description: 'Coding model',
        supportedReasoningEfforts: [
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' },
        ],
        defaultReasoningEffort: 'medium',
      },
    ])).toEqual([
      {
        id: 'gpt-current-codex',
        name: 'GPT Codex',
        description: 'Coding model',
        supportedEfforts: ['medium', 'high'],
        defaultEffort: 'medium',
      },
    ]);
  });

  it('initializes app-server and follows model/list pagination', async () => {
    const process = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(process, {
      stdin,
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    const requests: Array<Record<string, unknown>> = [];
    stdin.setEncoding('utf8');
    stdin.on('data', (line: string) => {
      const request = JSON.parse(line) as Record<string, unknown>;
      requests.push(request);
      if (request['method'] === 'initialize') {
        stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      } else if (request['method'] === 'model/list' && request['id'] === 2) {
        stdout.write(`${JSON.stringify({
          id: 2,
          result: {
            data: [{
              model: 'gpt-first',
              displayName: 'GPT First',
              description: 'First page',
              supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
              defaultReasoningEffort: 'medium',
            }],
            nextCursor: 'page-2',
          },
        })}\n`);
      } else if (request['method'] === 'model/list' && request['id'] === 3) {
        stdout.write(`${JSON.stringify({
          id: 3,
          result: {
            data: [{
              model: 'gpt-second',
              displayName: 'GPT Second',
              description: 'Second page',
              supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
              defaultReasoningEffort: 'high',
            }],
            nextCursor: null,
          },
        })}\n`);
      }
    });

    const models = await readCodexModelsFromAppServer(process, 1_000);

    expect(models.map((model) => model.id)).toEqual(['gpt-first', 'gpt-second']);
    expect(requests.map((request) => request['method'])).toEqual([
      'initialize',
      'initialized',
      'model/list',
      'model/list',
    ]);
    expect(process.kill).toHaveBeenCalled();
  });
});
