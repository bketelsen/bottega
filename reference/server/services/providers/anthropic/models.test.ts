import { describe, expect, it } from 'vitest';

import { mapClaudeModels } from './models.js';

describe('mapClaudeModels', () => {
  it('preserves live model ids and effort metadata', () => {
    expect(mapClaudeModels([
      {
        value: 'claude-sonnet-current',
        displayName: 'Claude Sonnet',
        description: 'Balanced model',
        supportedEffortLevels: ['low', 'high'],
      },
    ])).toEqual([
      {
        id: 'claude-sonnet-current',
        name: 'Claude Sonnet',
        description: 'Balanced model',
        supportedEfforts: ['low', 'high'],
        defaultEffort: 'high',
      },
    ]);
  });
});
