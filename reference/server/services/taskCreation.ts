import type { ProjectRow, TaskRow } from '../../shared/types/db.js';
import { projectsDb, tasksDb } from '../database/db.js';
import { deleteTaskArchive, writeTaskDoc } from './documentation.js';
import {
  createWorktree,
  isGitRepository,
  removeWorktree,
} from './worktree.js';

export interface CreateTaskWithWorkspaceOptions {
  project?: ProjectRow;
  projectId?: number;
  userId: number;
  title?: string | null | undefined;
  description?: string | null | undefined;
  documentContent?: string | null | undefined;
  yoloMode?: boolean;
  githubIssueNumber?: number | null;
  githubPrNumber?: number | null;
  existingWorktreeBranch?: string;
}

export type CreatedTaskWithWorkspace = TaskRow & {
  worktree_path?: string;
  worktree_branch?: string;
};

export class TaskCreationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TaskCreationError';
  }
}

export async function createTaskWithWorkspace(
  options: CreateTaskWithWorkspaceOptions,
): Promise<CreatedTaskWithWorkspace> {
  const {
    project: suppliedProject,
    projectId,
    userId,
    title = null,
    description = null,
    documentContent,
    yoloMode = false,
    githubIssueNumber = null,
    githubPrNumber = null,
    existingWorktreeBranch,
  } = options;
  const project = suppliedProject ?? (projectId ? projectsDb.getByIdAdmin(projectId) : undefined);
  if (!project) {
    throw new TaskCreationError(`Project ${projectId ?? 'unknown'} not found`);
  }
  const normalizedTitle = title?.trim() || null;
  const isGit = await isGitRepository(project.repo_folder_path);
  const created = tasksDb.create(project.id, normalizedTitle, yoloMode, userId, {
    githubIssueNumber,
    githubPrNumber,
  });
  let worktreeCreationAttempted = false;

  try {
    let workspace: Pick<CreatedTaskWithWorkspace, 'worktree_path' | 'worktree_branch'> = {};
    if (isGit) {
      worktreeCreationAttempted = true;
      const result = existingWorktreeBranch
        ? await createWorktree(
            project.repo_folder_path,
            created.id,
            normalizedTitle,
            project.subproject_path,
            { existingBranch: existingWorktreeBranch, projectId: project.id },
          )
        : await createWorktree(
            project.repo_folder_path,
            created.id,
            normalizedTitle,
            project.subproject_path,
            { projectId: project.id },
          );
      if (!result.success) {
        throw new TaskCreationError(`Failed to create worktree: ${result.error ?? 'Unknown error'}`);
      }
      workspace = {
        ...(result.worktreePath ? { worktree_path: result.worktreePath } : {}),
        ...(result.branch ? { worktree_branch: result.branch } : {}),
      };
    }

    const content = documentContent === undefined ? description?.trim() || '' : documentContent || '';
    writeTaskDoc(project.id, created.id, content);
    const task = tasksDb.getById(created.id);
    if (!task) {
      throw new TaskCreationError(`Created task ${created.id} could not be loaded`);
    }
    return { ...task, ...workspace };
  } catch (error) {
    // createWorktree can fail after `git worktree add`, so cleanup every
    // attempted Git workspace rather than only reported successes.
    if (worktreeCreationAttempted) {
      try {
        const rollback = await removeWorktree(project.repo_folder_path, created.id);
        if (rollback && !rollback.success) {
          console.error(`Failed to roll back worktree for task ${created.id}: ${rollback.error}`);
        }
      } catch (rollbackError) {
        console.error(`Failed to roll back worktree for task ${created.id}:`, rollbackError);
      }
    }
    try {
      deleteTaskArchive(project.id, created.id);
    } catch (archiveError) {
      console.error(`Failed to roll back archive for task ${created.id}:`, archiveError);
    }
    tasksDb.delete(created.id);
    if (error instanceof TaskCreationError) throw error;
    throw new TaskCreationError('Failed to create task documentation', { cause: error });
  }
}
