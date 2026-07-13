import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../database/db.js', () => ({
  projectsDb: {
    getByIdAdmin: vi.fn(),
  },
  tasksDb: {
    create: vi.fn(),
    getById: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('./documentation.js', () => ({
  writeTaskDoc: vi.fn(),
  deleteTaskArchive: vi.fn(),
}));

vi.mock('./worktree.js', () => ({
  isGitRepository: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

import { projectsDb, tasksDb } from '../database/db.js';
import { deleteTaskArchive, writeTaskDoc } from './documentation.js';
import { createWorktree, isGitRepository, removeWorktree } from './worktree.js';
import { createTaskWithWorkspace, TaskCreationError } from './taskCreation.js';

describe('createTaskWithWorkspace', () => {
  const project = {
    id: 3,
    repo_folder_path: '/repo',
    subproject_path: null,
  } as never;
  const created = { id: 7 } as never;
  const fullTask = {
    id: 7,
    project_id: 3,
    user_id: 5,
    title: 'Task',
    status: 'pending',
    workflow_complete: 0,
    workflow_blocked: 0,
    workflow_run_count: 0,
    planification_complete: 0,
    pr_agent_complete: 0,
    refinement_complete: 0,
    yolo_mode: 0,
    github_issue_number: 12,
    github_pr_number: null,
    github_plan_comment_id: null,
    github_last_human_comment_id: null,
    github_pr_evidence_hash: null,
    completed_at: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tasksDb.create).mockReturnValue(created);
    vi.mocked(tasksDb.getById).mockReturnValue(fullTask);
    vi.mocked(isGitRepository).mockResolvedValue(false);
    vi.mocked(removeWorktree).mockResolvedValue({ success: true });
  });

  it('returns the full task row and stores external identity atomically', async () => {
    const result = await createTaskWithWorkspace({
      project,
      userId: 5,
      title: ' Task ',
      description: ' Body ',
      githubIssueNumber: 12,
    });

    expect(tasksDb.create).toHaveBeenCalledWith(3, 'Task', false, 5, {
      githubIssueNumber: 12,
      githubPrNumber: null,
    });
    expect(writeTaskDoc).toHaveBeenCalledWith(3, 7, 'Body');
    expect(result).toEqual(fullTask);
  });

  it('loads the project for ID-based automation callers', async () => {
    vi.mocked(projectsDb.getByIdAdmin).mockReturnValue(project);

    await createTaskWithWorkspace({
      projectId: 3,
      userId: 5,
      title: 'Imported task',
      documentContent: '# Imported\n',
    });

    expect(projectsDb.getByIdAdmin).toHaveBeenCalledWith(3);
    expect(writeTaskDoc).toHaveBeenCalledWith(3, 7, '# Imported\n');
  });

  it('passes an existing PR branch only when explicitly requested', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(true);
    vi.mocked(createWorktree).mockResolvedValue({
      success: true,
      worktreePath: '/repo-worktrees/task-7',
      branch: 'feature/original-pr',
    });

    await createTaskWithWorkspace({
      project,
      userId: 5,
      title: 'Repair PR',
      existingWorktreeBranch: 'feature/original-pr',
    });

    expect(createWorktree).toHaveBeenCalledWith(
      '/repo', 7, 'Repair PR', null, { existingBranch: 'feature/original-pr' },
    );
  });

  it('rolls back the task when worktree creation fails', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(true);
    vi.mocked(createWorktree).mockResolvedValue({ success: false, error: 'branch exists' });

    await expect(
      createTaskWithWorkspace({ project, userId: 5, title: 'Task' }),
    ).rejects.toThrow('Failed to create worktree: branch exists');

    expect(tasksDb.delete).toHaveBeenCalledWith(7);
    expect(deleteTaskArchive).toHaveBeenCalledWith(3, 7);
    expect(removeWorktree).toHaveBeenCalledWith('/repo', 7);
  });

  it('removes the worktree and task when document creation fails', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(true);
    vi.mocked(createWorktree).mockResolvedValue({
      success: true,
      worktreePath: '/repo-worktrees/task-7',
      branch: 'task/7-task',
    });
    vi.mocked(writeTaskDoc).mockImplementation(() => {
      throw new Error('disk full');
    });

    await expect(
      createTaskWithWorkspace({ project, userId: 5, title: 'Task' }),
    ).rejects.toBeInstanceOf(TaskCreationError);

    expect(removeWorktree).toHaveBeenCalledWith('/repo', 7);
    expect(deleteTaskArchive).toHaveBeenCalledWith(3, 7);
    expect(tasksDb.delete).toHaveBeenCalledWith(7);
  });
});
