import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Codex } from '@openai/codex-sdk';

import { buildCodexSdkEnv } from '../../codexCredentials.js';

const MODEL_LIST_TIMEOUT_MS = 15_000;
const MAX_STDERR_LENGTH = 8_192;
const MAX_STDOUT_LINE_LENGTH = 1_048_576;

interface CodexProtocolModel {
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort: string;
}

interface CodexModelListResult {
  data: CodexProtocolModel[];
  nextCursor: string | null;
}

interface ProtocolResponse {
  id?: number;
  result?: CodexModelListResult;
  error?: { code?: number; message?: string };
}

export interface CodexModelListEntry {
  id: string;
  name: string;
  description: string;
  supportedEfforts: string[];
  defaultEffort: string | null;
}

export function mapCodexModels(models: CodexProtocolModel[]): CodexModelListEntry[] {
  return models.map((model) => ({
    id: model.model,
    name: model.displayName,
    description: model.description,
    supportedEfforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
    defaultEffort: model.defaultReasoningEffort || null,
  }));
}

function spawnCodexAppServer(userId: number): ChildProcessWithoutNullStreams {
  const env = Object.fromEntries(
    Object.entries(buildCodexSdkEnv(userId)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const codex = new Codex({ env });
  const executablePath = (codex as unknown as { exec: { executablePath: string } }).exec
    .executablePath;
  return spawn(executablePath, ['app-server', '--listen', 'stdio://'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export async function listCodexModels(userId: number): Promise<CodexModelListEntry[]> {
  return readCodexModelsFromAppServer(spawnCodexAppServer(userId));
}

export async function readCodexModelsFromAppServer(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = MODEL_LIST_TIMEOUT_MS,
): Promise<CodexModelListEntry[]> {
  return new Promise<CodexModelListEntry[]>((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = '';
    let stderr = '';
    let requestId = 1;
    const models: CodexProtocolModel[] = [];

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      const forceKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1_000);
      forceKill.unref();
      if (error) reject(error);
      else resolve(mapCodexModels(models));
    };

    const sendModelList = (cursor: string | null): void => {
      requestId += 1;
      child.stdin.write(`${JSON.stringify({
        method: 'model/list',
        id: requestId,
        params: { cursor, includeHidden: false },
      })}\n`);
    };

    const handleResponse = (response: ProtocolResponse): void => {
      if (response.error) {
        finish(new Error(`Codex model discovery failed: ${response.error.message ?? 'unknown error'}`));
        return;
      }
      if (response.id === 1) {
        child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
        sendModelList(null);
        return;
      }
      if (response.id !== requestId || !response.result) return;
      models.push(...response.result.data);
      if (response.result.nextCursor) sendModelList(response.result.nextCursor);
      else finish();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > MAX_STDOUT_LINE_LENGTH && !stdoutBuffer.includes('\n')) {
        finish(new Error('Codex model discovery returned an oversized response'));
        return;
      }
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) {
          try {
            handleResponse(JSON.parse(line) as ProtocolResponse);
          } catch (error) {
            finish(new Error(`Codex model discovery returned invalid JSON: ${String(error)}`));
          }
        }
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_LENGTH);
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (!settled) {
        finish(new Error(
          `Codex model discovery exited before responding (${signal ?? `code ${code ?? 1}`}): ${stderr.trim()}`,
        ));
      }
    });

    const timeout = setTimeout(
      () => finish(new Error('Codex model discovery timed out')),
      timeoutMs,
    );
    child.stdin.write(`${JSON.stringify({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: { name: 'bottega', title: 'Bottega', version: '1.0.0' },
        capabilities: null,
      },
    })}\n`);
  });
}
