import type { ChangeEvent } from 'react';
import type { ProjectAutonomyTier } from '../../shared/api/projects';
import { Input } from './ui/input';

interface GitHubProjectSettingsProps {
  githubRepo: string;
  onGithubRepoChange: (value: string) => void;
  autonomyTier: ProjectAutonomyTier;
  onAutonomyTierChange: (value: ProjectAutonomyTier) => void;
  githubAutomationEnabled: boolean;
  onGithubAutomationEnabledChange: (value: boolean) => void;
  disabled?: boolean;
  repositoryId?: number | null;
  installationId?: number | null;
  className: string;
  titleClassName: string;
  repoInputClassName: string;
}

function GitHubProjectSettings({
  githubRepo,
  onGithubRepoChange,
  autonomyTier,
  onAutonomyTierChange,
  githubAutomationEnabled,
  onGithubAutomationEnabledChange,
  disabled = false,
  repositoryId,
  installationId,
  className,
  titleClassName,
  repoInputClassName,
}: GitHubProjectSettingsProps) {
  const handleTierChange = (event: ChangeEvent<HTMLSelectElement>) => {
    onAutonomyTierChange(event.target.value as ProjectAutonomyTier);
  };

  return (
    <fieldset className={className} disabled={disabled} data-testid="github-settings">
      <legend className={titleClassName}>GitHub Automation</legend>
      <div className="space-y-2">
        <label htmlFor="github-repo" className="text-sm font-medium text-foreground">
          GitHub Repository
        </label>
        <Input
          id="github-repo"
          value={githubRepo}
          onChange={(event) => onGithubRepoChange(event.target.value)}
          placeholder="owner/repository"
          className={repoInputClassName}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="autonomy-tier" className="text-sm font-medium text-foreground">
          Autonomy Tier
        </label>
        <select
          id="autonomy-tier"
          value={autonomyTier}
          onChange={handleTierChange}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="advisory">Advisory</option>
          <option value="issues">Issues</option>
          <option value="pr">Pull requests</option>
          <option value="automerge">Auto-merge</option>
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={githubAutomationEnabled}
          onChange={(event) => onGithubAutomationEnabledChange(event.target.checked)}
        />
        Enable GitHub automation
      </label>
      {githubAutomationEnabled && (
        <p className="text-xs text-muted-foreground" data-testid="github-project-health">
          {repositoryId && installationId
            ? `Verified GitHub App repository #${repositoryId} (installation #${installationId})`
            : 'Repository verification is completed when these settings are saved.'}
        </p>
      )}
    </fieldset>
  );
}

export default GitHubProjectSettings;
