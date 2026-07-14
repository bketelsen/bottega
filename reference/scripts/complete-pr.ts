#!/usr/bin/env node

/**
 * CLI script to mark the current PR run ready for server-owned finalization.
 *
 * Usage: tsx scripts/complete-pr.ts <taskId>
 */

import { fileURLToPath } from 'url';
import path from 'path';

import { agentRunsDb, initializeDatabase } from '../server/database/db.js';
import type { AgentRunRow } from '../shared/types/db.js';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

export function markCurrentPrRunReady(taskId: string | undefined): AgentRunRow {
  if (!taskId) {
    throw new Error('Task ID is required');
  }

  if (!/^\d+$/.test(taskId)) {
    throw new Error('Task ID must be a number');
  }
  const parsedTaskId = Number(taskId);

  const run = agentRunsDb.markLatestRunningPrReady(parsedTaskId);
  if (!run) {
    throw new Error(`No current running PR run found for task ${parsedTaskId}`);
  }
  return run;
}

export async function runCompletePr(taskId: string | undefined): Promise<number> {
  try {
    await initializeDatabase();
    const run = markCurrentPrRunReady(taskId);
    const alreadyMarked = run.github_finalize_status !== 'ready';
    console.log('');
    console.log(
      alreadyMarked
        ? `${colors.cyan}Info:${colors.reset} PR run ${run.id} is already ${run.github_finalize_status}`
        : `${colors.green}${colors.bright}PR run is ready for GitHub finalization!${colors.reset}`,
    );
    console.log(`${colors.cyan}Task ID:${colors.reset} ${run.task_id}`);
    console.log(`${colors.cyan}Run ID:${colors.reset} ${run.id}`);
    console.log('');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${colors.red}Error:${colors.reset} ${message}`);
    if (!taskId) console.log(`\nUsage: tsx scripts/complete-pr.ts <taskId>`);
    return 1;
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) process.exitCode = await runCompletePr(process.argv[2]);
