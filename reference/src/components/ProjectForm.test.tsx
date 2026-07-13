import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectForm from './ProjectForm';

let isAdmin: 0 | 1 = 0;

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { is_admin: isAdmin } }),
}));

describe('ProjectForm GitHub settings', () => {
  beforeEach(() => {
    isAdmin = 0;
  });

  it('hides GitHub settings from non-admin users', () => {
    render(
      <ProjectForm
        isOpen
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.queryByText('GitHub Automation')).not.toBeInTheDocument();
  });

  it('submits normalized admin settings for server validation', async () => {
    isAdmin = 1;
    const onSubmit = vi.fn().mockResolvedValue({ success: true });
    render(
      <ProjectForm
        isOpen
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('Project Name'), { target: { value: 'Project' } });
    fireEvent.change(screen.getByLabelText('Repository Folder Path'), {
      target: { value: '/repos/project' },
    });
    fireEvent.change(screen.getByLabelText('GitHub Repository'), {
      target: { value: 'Owner/Repo' },
    });
    fireEvent.change(screen.getByLabelText('Autonomy Tier'), { target: { value: 'pr' } });
    fireEvent.click(screen.getByLabelText('Enable GitHub automation'));
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      name: 'Project',
      repoFolderPath: '/repos/project',
      githubRepo: 'Owner/Repo',
      githubAutomationEnabled: true,
      autonomyTier: 'pr',
    }));
  });
});
