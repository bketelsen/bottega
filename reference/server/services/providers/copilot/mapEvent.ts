// Copilot `SessionEvent` → `UnifiedMessage[]` mapper.
//
// This is the only place in the codebase that knows the Copilot SDK event
// shape. Every consumer above sees `UnifiedMessage` from
// `@shared/providers/types`.
//
// Reference for shapes: `node_modules/@github/copilot-sdk/dist/generated/
// session-events.d.ts`. The variants Bottega maps:
//   - `user.message`              → user (we also synthesise our own, but a
//                                    resumed turn may replay one)
//   - `assistant.message`         → assistant (final text for a message)
//   - `assistant.message_delta`   → stream_delta (incremental text)
//   - `assistant.reasoning`       → assistant_thinking (final reasoning text)
//   - `assistant.reasoning_delta` → stream_delta (incremental reasoning)
//   - `tool.execution_start`      → tool_use
//   - `tool.execution_complete`   → tool_result
//   - `assistant.usage`           → folded into the terminal result (no own row)
//   - `session.idle`              → result (clean end of turn)
//   - `session.error`             → result with isError:true
//
// The mapper is stateful (a factory, like `createOpenCodeEventMapper`)
// purely so it can fold the most recent `assistant.usage` token counts into
// the `session.idle` result — the idle event itself carries no usage.

import type { SessionEvent } from '@github/copilot-sdk';
import type {
  UnifiedMessage,
  UnifiedResultMessage,
  UnifiedSystemMessage,
} from '@shared/providers/types';

interface AggregateUsage {
  input_tokens?: number;
  output_tokens?: number;
}

// The generated event payloads are fully typed but verbose; we read a small
// known subset per variant. A narrow structural view keeps the mapper from
// importing every generated `*Data` interface.
type AnyEvent = {
  type: string;
  agentId?: string;
  data?: Record<string, unknown>;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export interface CopilotEventMapper {
  map(event: SessionEvent): UnifiedMessage[];
}

export function createCopilotEventMapper(
  providerSessionId: string | null,
): CopilotEventMapper {
  let usage: AggregateUsage | undefined;

  function unknownEvent(e: AnyEvent): UnifiedSystemMessage {
    return {
      type: 'system',
      id: `copilot_unknown:${e.type}:${Math.random()}`,
      provider: 'copilot',
      providerSessionId,
      raw: e,
      subtype: 'unknown',
    };
  }

  function map(event: SessionEvent): UnifiedMessage[] {
    const e = event as unknown as AnyEvent;
    const data = e.data ?? {};
    const isSubAgent = typeof e.agentId === 'string' && e.agentId.length > 0;

    switch (e.type) {
      case 'user.message':
        return [
          {
            type: 'user',
            id: str(data['interactionId']) || `copilot_user:${Math.random()}`,
            provider: 'copilot',
            providerSessionId,
            raw: e,
            content: str(data['content']),
          },
        ];

      case 'assistant.message':
        return [
          {
            type: 'assistant',
            id: str(data['messageId']) || `copilot_assistant:${Math.random()}`,
            provider: 'copilot',
            providerSessionId,
            raw: e,
            text: str(data['content']),
            isSubAgent,
            ...(typeof data['outputTokens'] === 'number'
              ? { usage: { output_tokens: data['outputTokens'] } }
              : {}),
            ...(typeof data['model'] === 'string'
              ? { model: data['model'] }
              : {}),
          },
        ];

      case 'assistant.message_delta':
        return [
          {
            type: 'stream_delta',
            id: `${str(data['messageId'])}:delta:${Math.random()}`,
            provider: 'copilot',
            providerSessionId,
            raw: e,
            delta: { text: str(data['deltaContent']) },
          },
        ];

      case 'assistant.reasoning':
        return [
          {
            type: 'assistant_thinking',
            id: str(data['reasoningId']) || `copilot_reasoning:${Math.random()}`,
            provider: 'copilot',
            providerSessionId,
            raw: e,
            text: str(data['content']),
          },
        ];

      case 'assistant.reasoning_delta':
        return [
          {
            type: 'stream_delta',
            id: `${str(data['reasoningId'])}:rdelta:${Math.random()}`,
            provider: 'copilot',
            providerSessionId,
            raw: e,
            delta: { thinking: str(data['deltaContent']) },
          },
        ];

      case 'tool.execution_start':
        return [
          {
            type: 'tool_use',
            id: `${str(data['toolCallId'])}:use`,
            provider: 'copilot',
            providerSessionId,
            raw: e,
            toolName: str(data['toolName']) || 'tool',
            toolUseId: str(data['toolCallId']),
            toolInput: data['arguments'] ?? {},
          },
        ];

      case 'tool.execution_complete':
        return [
          {
            type: 'tool_result',
            id: `${str(data['toolCallId'])}:result`,
            provider: 'copilot',
            providerSessionId,
            raw: e,
            toolUseId: str(data['toolCallId']),
            content: data['result'] ?? data['error'] ?? null,
            ...(data['success'] === false ? { isError: true } : {}),
          },
        ];

      case 'assistant.usage': {
        // No own row — accumulate so the terminal result can report it.
        const input = data['inputTokens'];
        const output = data['outputTokens'];
        usage = {
          ...(usage ?? {}),
          ...(typeof input === 'number' ? { input_tokens: input } : {}),
          ...(typeof output === 'number' ? { output_tokens: output } : {}),
        };
        return [];
      }

      case 'session.idle': {
        const result: UnifiedResultMessage = {
          type: 'result',
          id: `copilot_idle:${Math.random()}`,
          provider: 'copilot',
          providerSessionId,
          raw: e,
          isError: false,
          ...(usage ? { usage } : {}),
        };
        return [result];
      }

      case 'session.error': {
        const result: UnifiedResultMessage = {
          type: 'result',
          id: `copilot_error:${Math.random()}`,
          provider: 'copilot',
          providerSessionId,
          raw: e,
          isError: true,
          errors: [
            {
              message: str(data['message']) || 'Copilot session error',
              ...(typeof data['errorType'] === 'string'
                ? { errorType: data['errorType'] }
                : {}),
            },
          ],
        };
        return [result];
      }

      // Lifecycle/streaming-start/turn-boundary events carry no Bottega-
      // visible content; drop them rather than emitting noisy system rows.
      case 'session.start':
      case 'session.resume':
      case 'assistant.turn_start':
      case 'assistant.turn_end':
      case 'assistant.message_start':
      case 'assistant.intent':
      case 'command.execute':
      case 'command.completed':
      case 'command.queued':
        return [];

      default:
        return [unknownEvent(e)];
    }
  }

  return { map };
}
