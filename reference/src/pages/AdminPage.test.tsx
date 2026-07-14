import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AdminPage from './AdminPage';

const mocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
  listProjects: vi.fn(),
  getGitHubAppHealth: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, is_admin: 1 } }),
}));

vi.mock('../utils/api', () => ({
  api: {
    admin: {
      listUsers: mocks.listUsers,
      listProjects: mocks.listProjects,
      getGitHubAppHealth: mocks.getGitHubAppHealth,
    },
  },
}));

describe('AdminPage GitHub App health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listUsers.mockResolvedValue({ ok: true, json: async () => [] });
    mocks.listProjects.mockResolvedValue({ ok: true, json: async () => [] });
    mocks.getGitHubAppHealth.mockResolvedValue({
      ok: true,
      json: async () => ({
        mode: 'app',
        status: 'degraded',
        configured: true,
        appId: 123,
        appSlug: 'bottega',
        botLogin: 'bottega[bot]',
        botUserId: 456,
        webhookConfigured: false,
        webhookUrl: null,
        lastMetadataSuccessAt: 1,
        lastTokenMintSuccessAt: null,
        errorCode: null,
        error: 'GitHub webhook is not configured',
        projects: {
          automationEnabled: 1,
          ready: 0,
          missingIdentity: [{
            id: 7,
            name: 'Needs setup',
            missing: ['repository_id', 'installation_id'],
          }],
        },
      }),
    });
  });

  it('shows app and webhook health to administrators', async () => {
    render(<MemoryRouter><AdminPage /></MemoryRouter>);
    await waitFor(() => expect(mocks.getGitHubAppHealth).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'GitHub App' }));
    expect(await screen.findByText('App: bottega')).toBeInTheDocument();
    expect(screen.getByText('Webhook: not configured')).toBeInTheDocument();
    expect(screen.getByText('Bot identity: bottega[bot]')).toBeInTheDocument();
    expect(screen.getByText('Automation projects: 0/1 ready')).toBeInTheDocument();
    expect(screen.getByText('Needs setup: missing repository_id, installation_id')).toBeInTheDocument();
    expect(screen.getByText('GitHub webhook is not configured')).toBeInTheDocument();
  });
});
