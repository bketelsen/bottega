import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, FolderGit2, Github, Plus, RefreshCw } from 'lucide-react';
import { Button } from '../components/ui/button';
import { ScrollArea } from '../components/ui/scroll-area';
import { UserList, UserForm, ProjectMembersEditor } from '../components/Admin';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../utils/api';
import type {
  AdminUserListItem,
  AdminProjectListItem,
  GitHubAppHealthResponse,
} from '../../shared/api/admin';
import type { ApiError } from '../../shared/api/_common';
import type { UserFormSubmitData, UserFormSubmitResult } from '../components/Admin/UserForm';

type AdminTab = 'users' | 'projects' | 'github';

function formatHealthTime(value: number | null): string {
  return value === null ? 'never' : new Date(value).toLocaleString();
}

function AdminPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState<AdminTab>('users');

  const [users, setUsers] = useState<AdminUserListItem[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(true);
  const [isDeletingUser, setIsDeletingUser] = useState<number | null>(null);

  const [projects, setProjects] = useState<AdminProjectListItem[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [githubHealth, setGithubHealth] = useState<GitHubAppHealthResponse | null>(null);
  const [isLoadingGithubHealth, setIsLoadingGithubHealth] = useState(true);

  const [showUserForm, setShowUserForm] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUserListItem | null>(null);
  const [isSubmittingUser, setIsSubmittingUser] = useState(false);

  const [error, setError] = useState('');

  const isAdmin = user?.is_admin;

  useEffect(() => {
    if (user && !isAdmin) {
      navigate('/');
    }
  }, [user, isAdmin, navigate]);

  const loadUsers = useCallback(async () => {
    setIsLoadingUsers(true);
    setError('');
    try {
      const response = await api.admin.listUsers();
      if (response.ok) {
        const data = await response.json();
        setUsers(data);
      } else {
        const errorData = (await response.json()) as unknown as ApiError;
        setError(errorData.error || 'Failed to load users');
      }
    } catch {
      setError('Failed to load users');
    } finally {
      setIsLoadingUsers(false);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    setIsLoadingProjects(true);
    try {
      const response = await api.admin.listProjects();
      if (response.ok) {
        const data = await response.json();
        setProjects(data);
      }
    } catch (err) {
      console.error('Failed to load projects:', err);
    } finally {
      setIsLoadingProjects(false);
    }
  }, []);

  const loadGithubHealth = useCallback(async () => {
    setIsLoadingGithubHealth(true);
    try {
      const response = await api.admin.getGitHubAppHealth();
      if (response.ok) setGithubHealth(await response.json());
      else setError('Failed to load GitHub App health');
    } catch {
      setError('Failed to load GitHub App health');
    } finally {
      setIsLoadingGithubHealth(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) {
      void loadUsers();
      void loadProjects();
      void loadGithubHealth();
    }
  }, [isAdmin, loadUsers, loadProjects, loadGithubHealth]);

  const handleUserSubmit = async (data: UserFormSubmitData): Promise<UserFormSubmitResult> => {
    setIsSubmittingUser(true);
    try {
      let response: Response;
      if (editingUser) {
        response = await api.admin.updateUser(editingUser.id, data);
      } else {
        response = await api.admin.createUser(
          data.username,
          data.password ?? '',
          data.is_admin
        );
      }

      if (response.ok) {
        setShowUserForm(false);
        setEditingUser(null);
        await loadUsers();
        return {};
      } else {
        const errorData = (await response.json()) as unknown as ApiError;
        return { error: errorData.error || 'Operation failed' };
      }
    } catch {
      return { error: 'Operation failed' };
    } finally {
      setIsSubmittingUser(false);
    }
  };

  const handleDeleteUser = async (userToDelete: AdminUserListItem) => {
    if (!confirm(`Are you sure you want to delete user "${userToDelete.username}"?`)) {
      return;
    }

    setIsDeletingUser(userToDelete.id);
    try {
      const response = await api.admin.deleteUser(userToDelete.id);
      if (response.ok) {
        await loadUsers();
      } else {
        const errorData = (await response.json()) as unknown as ApiError;
        setError(errorData.error || 'Failed to delete user');
      }
    } catch {
      setError('Failed to delete user');
    } finally {
      setIsDeletingUser(null);
    }
  };

  const handleEditUser = (userToEdit: AdminUserListItem) => {
    setEditingUser(userToEdit);
    setShowUserForm(true);
  };

  const handleCreateUser = () => {
    setEditingUser(null);
    setShowUserForm(true);
  };

  // Show loading state while checking auth
  if (!user) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // Non-admin view (should redirect, but just in case)
  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <h1 className="text-xl font-semibold text-foreground mb-2">Access Denied</h1>
          <p className="text-muted-foreground">Admin privileges required</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/')}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-xl font-semibold text-foreground">Admin Panel</h1>
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            void loadUsers();
            void loadProjects();
            void loadGithubHealth();
          }}
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab('users')}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === 'users'
              ? 'text-primary border-b-2 border-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Users className="h-4 w-4" />
          Users
        </button>
        <button
          onClick={() => setActiveTab('projects')}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === 'projects'
              ? 'text-primary border-b-2 border-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <FolderGit2 className="h-4 w-4" />
          Project Memberships
        </button>
        <button
          onClick={() => setActiveTab('github')}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === 'github'
              ? 'text-primary border-b-2 border-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Github className="h-4 w-4" />
          GitHub App
        </button>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-4">
          {error && (
            <div className="mb-4 p-3 text-sm text-red-500 bg-red-500/10 rounded-md">
              {error}
              <button
                onClick={() => setError('')}
                className="ml-2 underline"
              >
                Dismiss
              </button>
            </div>
          )}

          {activeTab === 'users' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-medium text-foreground">User Management</h2>
                <Button onClick={handleCreateUser} size="sm">
                  <Plus className="h-4 w-4 mr-1" />
                  Add User
                </Button>
              </div>

              {isLoadingUsers ? (
                <div className="text-center py-8 text-muted-foreground">
                  Loading users...
                </div>
              ) : (
                <UserList
                  users={users}
                  onEdit={handleEditUser}
                  onDelete={handleDeleteUser}
                  currentUserId={user?.id}
                  isDeleting={isDeletingUser}
                />
              )}
            </div>
          )}

          {activeTab === 'projects' && (
            <div className="space-y-4">
              <h2 className="text-lg font-medium text-foreground">Project Memberships</h2>
              <p className="text-sm text-muted-foreground">
                Select a project to manage its members. All members have equal access to the project.
              </p>

              {isLoadingProjects ? (
                <div className="text-center py-8 text-muted-foreground">
                  Loading projects...
                </div>
              ) : (
                <ProjectMembersEditor
                  projects={projects}
                  users={users}
                  onMembershipChange={loadProjects}
                />
              )}
            </div>
          )}

          {activeTab === 'github' && (
            <div className="space-y-4" data-testid="github-app-health">
              <h2 className="text-lg font-medium text-foreground">GitHub App Health</h2>
              {isLoadingGithubHealth ? (
                <p className="text-sm text-muted-foreground">Checking GitHub App...</p>
              ) : githubHealth ? (
                <div className="rounded-md border border-border p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{githubHealth.mode === 'app' ? 'App mode' : 'Host mode'}</span>
                    <span className="text-sm capitalize">{githubHealth.status}</span>
                  </div>
                  {githubHealth.appSlug && <p className="text-sm">App: {githubHealth.appSlug}</p>}
                  {githubHealth.botLogin && <p className="text-sm">Bot identity: {githubHealth.botLogin}</p>}
                  {githubHealth.appId && <p className="text-sm">App ID: {githubHealth.appId}</p>}
                  <p className="text-sm text-muted-foreground">
                    Webhook: {githubHealth.webhookConfigured ? 'configured' : 'not configured'}
                  </p>
                  {githubHealth.webhookUrl && (
                    <p className="text-sm text-muted-foreground break-all">Webhook URL: {githubHealth.webhookUrl}</p>
                  )}
                  <p className="text-sm text-muted-foreground">
                    Last metadata check: {formatHealthTime(githubHealth.lastMetadataSuccessAt)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Last token mint: {formatHealthTime(githubHealth.lastTokenMintSuccessAt)}
                  </p>
                  <div className="pt-2 border-t border-border text-sm">
                    <p>
                      Automation projects: {githubHealth.projects.ready}/{githubHealth.projects.automationEnabled} ready
                    </p>
                    {githubHealth.projects.missingIdentity.map((project) => (
                      <p key={project.id} className="text-amber-600 dark:text-amber-400">
                        {project.name}: missing {project.missing.join(', ')}
                      </p>
                    ))}
                  </div>
                  {githubHealth.mode === 'host' && (
                    <p className="text-sm text-amber-600 dark:text-amber-400">
                      Host mode is deprecated. Configure GitHub App mode for repository-scoped automation.
                    </p>
                  )}
                  {githubHealth.error && (
                    <p className="text-sm text-red-500">
                      {githubHealth.errorCode ? `${githubHealth.errorCode}: ` : ''}{githubHealth.error}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Health information is unavailable.</p>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* User Form Modal */}
      <UserForm
        isOpen={showUserForm}
        onClose={() => {
          setShowUserForm(false);
          setEditingUser(null);
        }}
        onSubmit={handleUserSubmit}
        user={editingUser}
        isSubmitting={isSubmittingUser}
      />
    </div>
  );
}

export default AdminPage;
