import express, { type Request, type Response } from 'express';
import { projectsDb, userDb } from '../database/db.js';
import {
  getAllProjects,
  getProject,
  updateProject,
  deleteProject,
} from '../services/projectService.js';
import { saveConversationUpload } from '../services/documentation.js';
import { upload } from '../middleware/upload.js';
import type { ApiError } from '../../shared/api/_common.js';
import type {
  CreateProjectResponse,
  DeleteProjectResponse,
  GetProjectResponse,
  ListProjectsResponse,
  ProjectReadinessErrorResponse,
  UpdateProjectResponse,
  UploadProjectFileResponse,
} from '../../shared/api/projects.js';
import type { ProjectUpdates } from '../database/db.js';
import { loadAgentModelSettings } from '../services/agentModelSettings.js';
import { getCredentialStore } from '../services/credentials/registry.js';
import type { ProjectAutonomyTier } from '../../shared/api/projects.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import {
  IdParamsSchema,
  type IdParams,
} from '../../shared/schemas/_common.js';
import {
  CreateProjectBodySchema,
  type CreateProjectBody,
  UpdateProjectBodySchema,
  type UpdateProjectBody,
} from '../../shared/schemas/projects.js';
import {
  getGitHubAppHealth,
  resolveRepositoryInstallation,
  type GitHubRepositoryInstallation,
} from '../services/github/appAuth.js';
import { githubClient } from '../services/github/client.js';
import type { GitHubProject } from '../services/github/capabilities.js';

const router = express.Router();

/**
 * Best-effort provisioning of the Bottega workflow labels on a project's
 * linked repository. Runs after automation is enabled so the label-gated
 * issue-intake flow works without operators creating labels by hand. Never
 * throws: a provisioning failure is logged but must not fail project
 * create/update (the labels can also be added later).
 */
async function provisionWorkflowLabels(project: GitHubProject): Promise<void> {
  if (project.github_automation_enabled !== 1 || !project.github_repo) return;
  try {
    const { created } = await githubClient.ensureLabels(project);
    if (created.length > 0) {
      console.log(
        `[Projects] Provisioned workflow labels on ${project.github_repo}: ${created.join(', ')}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[Projects] Failed to provision workflow labels on ${project.github_repo}: ${message}`,
    );
  }
}

class ProjectReadinessError extends Error {
  constructor(message: string, readonly code = 'PROJECT_AUTOMATION_NOT_READY') {
    super(message);
  }
}

const hasGitHubMutation = (body: CreateProjectBody | UpdateProjectBody): boolean =>
  body.githubRepo !== undefined ||
  body.githubAutomationEnabled !== undefined ||
  body.autonomyTier !== undefined;

async function validateAutomationReadiness(
  ownerId: number,
  githubRepo: string | null,
  autonomyTier: ProjectAutonomyTier,
): Promise<void> {
  if (!githubRepo) {
    throw new ProjectReadinessError('Link a GitHub repository before enabling automation');
  }
  if (!userDb.getUserById(ownerId)) {
    throw new ProjectReadinessError('The project owner is not an active user');
  }

  let settings;
  try {
    settings = loadAgentModelSettings(ownerId);
  } catch {
    throw new ProjectReadinessError(
      'The project owner must configure agent models before enabling automation',
    );
  }

  const providers = new Set(Object.values(settings).map((setting) => setting.provider));
  for (const provider of providers) {
    try {
      const status = await getCredentialStore(provider).getStatus(ownerId);
      if (!status.authenticated) throw new Error('missing');
    } catch {
      throw new ProjectReadinessError(
        `The project owner must connect ${provider} before enabling automation`,
      );
    }
  }

  if (
    process.env.GITHUB_AUTH_MODE?.trim() !== 'app' &&
    (autonomyTier === 'pr' || autonomyTier === 'automerge')
  ) {
    const gitConfig = userDb.getGitConfig(ownerId);
    if (!gitConfig?.git_name?.trim() || !gitConfig.git_email?.trim()) {
      throw new ProjectReadinessError(
        'The project owner must configure a Git name and email for PR automation',
      );
    }
  }
}

async function resolveAppRepository(
  githubRepo: string | null,
): Promise<GitHubRepositoryInstallation | null> {
  if (process.env.GITHUB_AUTH_MODE?.trim() !== 'app') return null;
  if (!githubRepo) {
    throw new ProjectReadinessError(
      'Link a GitHub repository before enabling automation',
      'GITHUB_REPOSITORY_NOT_SELECTED',
    );
  }
  let health: Awaited<ReturnType<typeof getGitHubAppHealth>>;
  try {
    health = await getGitHubAppHealth();
  } catch (error) {
    throw new ProjectReadinessError(
      error instanceof Error ? error.message : 'GitHub App authentication is not configured',
      (error as { code?: string }).code ?? 'GITHUB_APP_NOT_CONFIGURED',
    );
  }
  if (health.status === 'error' || !health.configured) {
    throw new ProjectReadinessError(
      health.error ?? 'GitHub App authentication is not healthy',
      health.errorCode ?? 'GITHUB_APP_NOT_CONFIGURED',
    );
  }
  try {
    return await resolveRepositoryInstallation(githubRepo);
  } catch (error) {
    throw new ProjectReadinessError(
      error instanceof Error ? error.message : 'GitHub repository verification failed',
      (error as { code?: string }).code ?? 'GITHUB_REPOSITORY_NOT_SELECTED',
    );
  }
}

router.get('/', (req: Request, res: Response<ListProjectsResponse | ApiError>) => {
  try {
    const userId = req.user!.id;
    const projects = getAllProjects(userId);
    res.json(projects);
  } catch (error) {
    console.error('Error listing projects:', error);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

router.post(
  '/',
  validateBody(CreateProjectBodySchema),
  async (
    req: Request,
    res: Response<CreateProjectResponse | ProjectReadinessErrorResponse | ApiError>,
  ) => {
    try {
      const userId = req.user!.id;
      const body = req.validated!.body as CreateProjectBody;
      const { name, repoFolderPath, subprojectPath } = body;

      if (hasGitHubMutation(body) && req.user!.is_admin !== 1) {
        return res.status(403).json({ error: 'Admin access is required to change GitHub settings' });
      }

      let githubRepo = body.githubRepo ?? null;
      const autonomyTier = body.autonomyTier ?? 'advisory';
      let appRepository: GitHubRepositoryInstallation | null = null;
      if (body.githubAutomationEnabled) {
        await validateAutomationReadiness(userId, githubRepo, autonomyTier);
        appRepository = await resolveAppRepository(githubRepo);
        githubRepo = appRepository?.canonicalFullName ?? githubRepo;
      }

      const created = projectsDb.create(
        userId,
        name.trim(),
        repoFolderPath.trim(),
        subprojectPath?.trim() || null,
      );

      if (hasGitHubMutation(body)) {
        const updates: ProjectUpdates = {
          github_repo: githubRepo,
          github_automation_enabled: body.githubAutomationEnabled ? 1 : 0,
          autonomy_tier: autonomyTier,
        };
        try {
          const updated = updateProject(created.id, userId, updates);
          if (!updated) throw new Error('Created project settings could not be saved');
          if (appRepository) {
            projectsDb.updateGitHubIdentity(
              created.id,
              appRepository.canonicalFullName,
              appRepository.repositoryId,
              appRepository.installationId,
            );
          }
        } catch (error) {
          deleteProject(created.id, userId);
          throw error;
        }
      }

      const project = projectsDb.getById(created.id, userId);
      if (!project) throw new Error('Created project could not be reloaded');
      await provisionWorkflowLabels(project);
      res.status(201).json(project);
    } catch (error) {
      console.error('Error creating project:', error);
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ProjectReadinessError) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      if (code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('UNIQUE')) {
        return res
          .status(409)
          .json({ error: 'A project with this repository path already exists' });
      }
      res.status(500).json({ error: 'Failed to create project' });
    }
  },
);

router.get(
  '/:id',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<GetProjectResponse | ApiError>) => {
    try {
      const userId = req.user!.id;
      const { id: projectId } = req.validated!.params as IdParams;

      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      res.json(project);
    } catch (error) {
      console.error('Error getting project:', error);
      res.status(500).json({ error: 'Failed to get project' });
    }
  },
);

router.put(
  '/:id',
  validateParams(IdParamsSchema),
  validateBody(UpdateProjectBodySchema),
  async (
    req: Request,
    res: Response<UpdateProjectResponse | ProjectReadinessErrorResponse | ApiError>,
  ) => {
    try {
      const userId = req.user!.id;
      const { id: projectId } = req.validated!.params as IdParams;
      const body = req.validated!.body as UpdateProjectBody;

      if (hasGitHubMutation(body) && req.user!.is_admin !== 1) {
        return res.status(403).json({ error: 'Admin access is required to change GitHub settings' });
      }

      let appRepository: GitHubRepositoryInstallation | null = null;
      if (hasGitHubMutation(body)) {
        const existing = getProject(projectId, userId);
        if (!existing) {
          return res.status(404).json({ error: 'Project not found' });
        }

        const githubRepo = body.githubRepo !== undefined
          ? body.githubRepo
          : (existing.github_repo ?? null);
        const automationEnabled = body.githubAutomationEnabled !== undefined
          ? body.githubAutomationEnabled
          : existing.github_automation_enabled === 1;
        const autonomyTier = body.autonomyTier ?? existing.autonomy_tier ?? 'advisory';
        if (automationEnabled) {
          await validateAutomationReadiness(existing.user_id, githubRepo, autonomyTier);
          appRepository = await resolveAppRepository(githubRepo);
        }
      }

      const updates: ProjectUpdates = {};
      if (body.name !== undefined) {
        updates.name = body.name.trim();
      }
      if (body.repoFolderPath !== undefined) {
        updates.repo_folder_path = body.repoFolderPath.trim();
      }
      if (body.subprojectPath !== undefined) {
        updates.subproject_path = body.subprojectPath?.trim() || null;
      }
      if (body.githubRepo !== undefined) {
        updates.github_repo = appRepository?.canonicalFullName ?? body.githubRepo;
      }
      if (body.githubAutomationEnabled !== undefined) {
        updates.github_automation_enabled = body.githubAutomationEnabled ? 1 : 0;
      }
      if (body.autonomyTier !== undefined) {
        updates.autonomy_tier = body.autonomyTier;
      }

      const verifiedProject = appRepository
        ? projectsDb.updateGitHubIdentity(
          projectId,
          appRepository.canonicalFullName,
          appRepository.repositoryId,
          appRepository.installationId,
        )
        : undefined;

      const project = updateProject(projectId, userId, updates);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      await provisionWorkflowLabels(project);

      res.json(verifiedProject ? { ...verifiedProject, ...project } : project);
    } catch (error) {
      console.error('Error updating project:', error);
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ProjectReadinessError) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      if (code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('UNIQUE')) {
        return res
          .status(409)
          .json({ error: 'A project with this repository path already exists' });
      }
      res.status(500).json({ error: 'Failed to update project' });
    }
  },
);

router.delete(
  '/:id',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<DeleteProjectResponse | ApiError>) => {
    try {
      const userId = req.user!.id;
      const { id: projectId } = req.validated!.params as IdParams;

      const deleted = deleteProject(projectId, userId);
      if (!deleted) {
        return res.status(404).json({ error: 'Project not found' });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting project:', error);
      res.status(500).json({ error: 'Failed to delete project' });
    }
  },
);

router.post(
  '/:id/upload',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<UploadProjectFileResponse | ApiError>) => {
    const userId = req.user!.id;
    const { id: projectId } = req.validated!.params as IdParams;

    const project = getProject(projectId, userId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    upload.single('file')(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : JSON.stringify(err);
        return res.status(400).json({ error: message });
      }

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        return res.status(400).json({ error: 'No file provided' });
      }

      try {
        const fileInfo = saveConversationUpload(
          project.repo_folder_path,
          file.originalname,
          file.buffer,
        );
        res.status(201).json({ success: true, file: fileInfo });
      } catch (saveError) {
        console.error('Error saving upload:', saveError);
        res.status(500).json({ error: 'Failed to save file' });
      }
    });
  },
);

export default router;
