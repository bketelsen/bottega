import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../database/db.js', () => ({
  appSettingsDb: { getValue: vi.fn() },
}));

import { appSettingsDb } from '../../database/db.js';
import { hasGitHubPrTriggerMention } from './trigger.js';

describe('GitHub PR trigger mention', () => {
  beforeEach(() => {
    vi.mocked(appSettingsDb.getValue).mockReturnValue('repair.bot');
  });

  it('uses the configured escaped trigger and accepts trailing punctuation', () => {
    expect(hasGitHubPrTriggerMention('please @repair.bot, retry')).toBe(true);
    expect(hasGitHubPrTriggerMention('@repairXbot retry')).toBe(false);
    expect(hasGitHubPrTriggerMention('@repair.bot-extra retry')).toBe(false);
    expect(hasGitHubPrTriggerMention('@bottega retry')).toBe(false);
  });
});
