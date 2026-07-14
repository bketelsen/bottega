import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import GitHubProjectSettings from './GitHubProjectSettings';

describe('GitHubProjectSettings', () => {
  const props = {
    githubRepo: 'owner/repo',
    onGithubRepoChange: vi.fn(),
    autonomyTier: 'advisory' as const,
    onAutonomyTierChange: vi.fn(),
    githubAutomationEnabled: true,
    onGithubAutomationEnabledChange: vi.fn(),
    className: '',
    titleClassName: '',
    repoInputClassName: '',
  };

  it('shows persisted GitHub App identity health', () => {
    render(<GitHubProjectSettings {...props} repositoryId={100} installationId={10} />);
    expect(screen.getByTestId('github-project-health')).toHaveTextContent(
      'Verified GitHub App repository #100 (installation #10)',
    );
  });

  it('explains pending verification for an enabled legacy project', () => {
    render(<GitHubProjectSettings {...props} />);
    expect(screen.getByTestId('github-project-health')).toHaveTextContent(
      'verification is completed when these settings are saved',
    );
  });
});
