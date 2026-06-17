import { describe, it, expect } from 'vitest';
import { createCopilotEventMapper } from './mapEvent.js';
import type { SessionEvent } from '@github/copilot-sdk';

// The mapper only reads `type`, `agentId`, and a small `data` subset, so we
// cast minimal literals through `unknown` to `SessionEvent`.
const ev = (type: string, data: Record<string, unknown> = {}, agentId?: string): SessionEvent =>
  ({ type, data, ...(agentId ? { agentId } : {}) }) as unknown as SessionEvent;

describe('createCopilotEventMapper', () => {
  it('maps assistant.message to a unified assistant message with model + usage', () => {
    const mapper = createCopilotEventMapper('sess-1');
    const out = mapper.map(
      ev('assistant.message', { content: 'hi', model: 'gpt-5', outputTokens: 7, messageId: 'm1' }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'assistant',
      text: 'hi',
      model: 'gpt-5',
      isSubAgent: false,
      providerSessionId: 'sess-1',
      usage: { output_tokens: 7 },
    });
  });

  it('flags sub-agent messages via agentId', () => {
    const mapper = createCopilotEventMapper('s');
    const [msg] = mapper.map(ev('assistant.message', { content: 'x', messageId: 'm' }, 'agent-9'));
    expect(msg).toMatchObject({ type: 'assistant', isSubAgent: true });
  });

  it('maps message and reasoning deltas to stream_delta', () => {
    const mapper = createCopilotEventMapper('s');
    expect(mapper.map(ev('assistant.message_delta', { deltaContent: 'ab', messageId: 'm' }))[0])
      .toMatchObject({ type: 'stream_delta', delta: { text: 'ab' } });
    expect(mapper.map(ev('assistant.reasoning_delta', { deltaContent: 'th', reasoningId: 'r' }))[0])
      .toMatchObject({ type: 'stream_delta', delta: { thinking: 'th' } });
  });

  it('maps tool start/complete to tool_use and tool_result', () => {
    const mapper = createCopilotEventMapper('s');
    const [use] = mapper.map(
      ev('tool.execution_start', { toolCallId: 't1', toolName: 'Bash', arguments: { command: 'ls' } }),
    );
    expect(use).toMatchObject({ type: 'tool_use', toolName: 'Bash', toolUseId: 't1', toolInput: { command: 'ls' } });

    const [okResult] = mapper.map(ev('tool.execution_complete', { toolCallId: 't1', success: true, result: 'out' }));
    expect(okResult).toMatchObject({ type: 'tool_result', toolUseId: 't1', content: 'out' });
    expect((okResult as { isError?: boolean }).isError).toBeUndefined();

    const [errResult] = mapper.map(ev('tool.execution_complete', { toolCallId: 't2', success: false, error: 'nope' }));
    expect(errResult).toMatchObject({ type: 'tool_result', toolUseId: 't2', isError: true });
  });

  it('folds the latest assistant.usage into the terminal session.idle result', () => {
    const mapper = createCopilotEventMapper('s');
    expect(mapper.map(ev('assistant.usage', { model: 'gpt-5', inputTokens: 10, outputTokens: 20 }))).toEqual([]);
    const [result] = mapper.map(ev('session.idle', {}));
    expect(result).toMatchObject({
      type: 'result',
      isError: false,
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  });

  it('maps session.error to an error result', () => {
    const mapper = createCopilotEventMapper('s');
    const [result] = mapper.map(ev('session.error', { message: 'kaboom', errorType: 'quota' }));
    expect(result).toMatchObject({ type: 'result', isError: true });
    expect((result as { errors?: unknown[] }).errors).toBeDefined();
  });

  it('drops turn-boundary lifecycle events', () => {
    const mapper = createCopilotEventMapper('s');
    expect(mapper.map(ev('assistant.turn_start', {}))).toEqual([]);
    expect(mapper.map(ev('command.execute', {}))).toEqual([]);
  });
});
