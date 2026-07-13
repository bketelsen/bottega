import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRow } from '../../shared/types/db';
import ProjectEditPageWrapper from './ProjectEditPageWrapper';

const mocks = vi.hoisted(() => ({
  updateProject: vi.fn(),
  getWebServer: vi.fn(),
  updateWebServerConfig: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { is_admin: 1 } }),
}));

const project: ProjectRow = {
  id: 7,
  user_id: 1,
  name: 'Project',
  repo_folder_path: '/repos/project',
  subproject_path: 'packages/app',
  active_worktree_task_id: null,
  serve_symlink_path: null,
  systemd_service_name: null,
  app_url: null,
  github_repo: 'owner/repo',
  github_automation_enabled: 1,
  autonomy_tier: 'pr',
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
};

vi.mock('../contexts/TaskContext', () => ({
  useTaskContext: () => ({
    projects: [project],
    loadProjects: vi.fn(),
    updateProject: mocks.updateProject,
    deleteProject: vi.fn(),
    isLoadingProjects: false,
  }),
}));

vi.mock('../utils/api', () => ({
  api: {
    projects: {
      getWebServer: mocks.getWebServer,
      updateWebServerConfig: mocks.updateWebServerConfig,
    },
    tasks: { cleanupOldCompleted: vi.fn() },
  },
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/7/edit']}>
      <Routes>
        <Route path="/projects/:projectId/edit" element={<ProjectEditPageWrapper />} />
        <Route path="/projects/:projectId" element={<div>Project detail</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProjectEditPageWrapper GitHub updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateProject.mockResolvedValue({ success: true });
    mocks.getWebServer.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        serveSymlinkPath: '',
        systemdServiceName: '',
        appUrl: '',
      }),
    });
  });

  it('does not resubmit unchanged GitHub settings with an ordinary edit', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Project Name'), {
      target: { value: 'Renamed project' },
    });
    fireEvent.click(screen.getByTestId('save-button'));

    await waitFor(() => expect(mocks.updateProject).toHaveBeenCalledWith(7, {
      name: 'Renamed project',
      subprojectPath: 'packages/app',
    }));
  });

  it('sends only the GitHub field that changed', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Autonomy Tier'), {
      target: { value: 'automerge' },
    });
    fireEvent.click(screen.getByTestId('save-button'));

    await waitFor(() => expect(mocks.updateProject).toHaveBeenCalledWith(7, {
      name: 'Project',
      subprojectPath: 'packages/app',
      autonomyTier: 'automerge',
    }));
  });

  it('leaves canonical normalization to the server', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('GitHub Repository'), {
      target: { value: '  https://github.com/Owner/Repo.git  ' },
    });
    fireEvent.click(screen.getByTestId('save-button'));

    await waitFor(() => expect(mocks.updateProject).toHaveBeenCalledWith(7, {
      name: 'Project',
      subprojectPath: 'packages/app',
      githubRepo: 'https://github.com/Owner/Repo.git',
    }));
  });
});
