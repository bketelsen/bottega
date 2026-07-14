import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/database/db.js', () => ({
  agentRunsDb: {
    markLatestRunningPrReady: vi.fn(),
  },
  initializeDatabase: vi.fn().mockResolvedValue(undefined),
}));

import { agentRunsDb, initializeDatabase } from '../server/database/db.js';
import { markCurrentPrRunReady, runCompletePr } from './complete-pr.js';

const run = {
  id: 12,
  task_id: 7,
  agent_type: 'pr',
  status: 'running',
  github_finalize_status: 'ready',
};

describe('complete-pr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentRunsDb.markLatestRunningPrReady).mockReturnValue(run as never);
  });

  it('marks the current running PR run ready instead of updating task state', () => {
    expect(markCurrentPrRunReady('7')).toEqual(run);
    expect(agentRunsDb.markLatestRunningPrReady).toHaveBeenCalledWith(7);
  });

  it.each([undefined, '', 'abc', '12oops', '-1'])(
    'rejects invalid task ID %s',
    (taskId) => {
      expect(() => markCurrentPrRunReady(taskId)).toThrow(/Task ID/);
      expect(agentRunsDb.markLatestRunningPrReady).not.toHaveBeenCalled();
    },
  );

  it('fails clearly when there is no current running PR run', () => {
    vi.mocked(agentRunsDb.markLatestRunningPrReady).mockReturnValue(undefined);
    expect(() => markCurrentPrRunReady('7')).toThrow(
      'No current running PR run found for task 7',
    );
  });

  it.each(['ready', 'finalizing', 'finalized'] as const)(
    'succeeds idempotently when the run is already %s',
    async (status) => {
      vi.mocked(agentRunsDb.markLatestRunningPrReady).mockReturnValue({
        ...run,
        github_finalize_status: status,
      } as never);

      await expect(runCompletePr('7')).resolves.toBe(0);
      expect(initializeDatabase).toHaveBeenCalledOnce();
    },
  );

  it('returns a failing exit code when no current run exists', async () => {
    vi.mocked(agentRunsDb.markLatestRunningPrReady).mockReturnValue(undefined);
    await expect(runCompletePr('7')).resolves.toBe(1);
  });
});
