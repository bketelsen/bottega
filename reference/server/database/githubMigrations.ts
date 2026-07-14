import type Database from 'better-sqlite3';

import { normalizeGitHubRepository } from '../../shared/schemas/github.js';

interface ProjectIdentityRow {
  id: number;
  github_repo: string;
}

interface ProjectRepositoryIdRow {
  id: number;
  github_repository_id: number;
}

interface TaskIdentityRow {
  id: number;
  project_id: number;
  github_issue_number: number | null;
  github_pr_number: number | null;
}

interface RunningAgentRow {
  id: number;
  task_id: number;
}

export function enforceGitHubIdentityConstraints(
  database: Database.Database,
  warn: (message: string) => void = console.warn,
): void {
  const warnings: string[] = [];
  const migrate = database.transaction(() => {
    const projects = database.prepare(
      `SELECT id, github_repo FROM projects
       WHERE github_repo IS NOT NULL
       ORDER BY COALESCE(created_at, '') ASC, id ASC`,
    ).all() as ProjectIdentityRow[];
    const retainedRepos = new Map<string, number>();
    const normalizedRepos = new Map<number, string>();

    for (const project of projects) {
      let normalized: string;
      try {
        normalized = normalizeGitHubRepository(project.github_repo);
      } catch {
        database.prepare(
          'UPDATE projects SET github_repo = NULL, github_automation_enabled = 0 WHERE id = ?',
        ).run(project.id);
        warnings.push(
          `[Migration] Disabled GitHub automation for project ${project.id}: malformed repository`,
        );
        continue;
      }

      const retainedId = retainedRepos.get(normalized);
      if (retainedId !== undefined) {
        database.prepare(
          'UPDATE projects SET github_repo = NULL, github_automation_enabled = 0 WHERE id = ?',
        ).run(project.id);
        warnings.push(
          `[Migration] Disabled GitHub automation for project ${project.id}: repository ${normalized} is retained by older project ${retainedId}`,
        );
        continue;
      }
      retainedRepos.set(normalized, project.id);
      normalizedRepos.set(project.id, normalized);
    }
    const updateRepository = database.prepare('UPDATE projects SET github_repo = ? WHERE id = ?');
    for (const [projectId, repository] of normalizedRepos) {
      updateRepository.run(repository, projectId);
    }

    const tasks = database.prepare(
      `SELECT id, project_id, github_issue_number, github_pr_number FROM tasks
       ORDER BY COALESCE(created_at, '') ASC, id ASC`,
    ).all() as TaskIdentityRow[];
    for (const [column, label] of [
      ['github_issue_number', 'issue'],
      ['github_pr_number', 'pull request'],
    ] as const) {
      const retained = new Map<string, number>();
      const clearIdentity = database.prepare(`UPDATE tasks SET ${column} = NULL WHERE id = ?`);
      for (const task of tasks) {
        const number = task[column];
        if (number === null) continue;
        const key = `${task.project_id}:${number}`;
        const retainedId = retained.get(key);
        if (retainedId === undefined) {
          retained.set(key, task.id);
          continue;
        }
        clearIdentity.run(task.id);
        warnings.push(
          `[Migration] Cleared duplicate GitHub ${label} ${number} from task ${task.id}; older task ${retainedId} retains it`,
        );
      }
    }

    const running = database.prepare(
      `SELECT id, task_id FROM task_agent_runs
       WHERE status = 'running'
       ORDER BY COALESCE(created_at, '') DESC, id DESC`,
    ).all() as RunningAgentRow[];
    const retainedRuns = new Map<number, number>();
    const failRun = database.prepare(
      `UPDATE task_agent_runs
       SET status = 'failed', completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    );
    for (const run of running) {
      const retainedId = retainedRuns.get(run.task_id);
      if (retainedId === undefined) {
        retainedRuns.set(run.task_id, run.id);
        continue;
      }
      failRun.run(run.id);
      warnings.push(
        `[Migration] Failed older running agent ${run.id} for task ${run.task_id}; newest run ${retainedId} remains running`,
      );
    }

    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_github_repo
        ON projects(github_repo COLLATE NOCASE)
        WHERE github_repo IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_github_issue
        ON tasks(project_id, github_issue_number)
        WHERE github_issue_number IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_github_pr
        ON tasks(project_id, github_pr_number)
        WHERE github_pr_number IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_agent_runs_one_running
        ON task_agent_runs(task_id)
        WHERE status = 'running';
    `);
  });

  migrate.immediate();
  for (const message of warnings) warn(message);
}

export function migrateGitHubAppProjectIdentity(
  database: Database.Database,
  warn: (message: string) => void = console.warn,
): void {
  const warnings: string[] = [];
  const migrate = database.transaction(() => {
    const columns = database.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
    const names = new Set(columns.map(({ name }) => name));
    if (!names.has('github_repository_id')) {
      database.exec('ALTER TABLE projects ADD COLUMN github_repository_id INTEGER');
    }
    if (!names.has('github_installation_id')) {
      database.exec('ALTER TABLE projects ADD COLUMN github_installation_id INTEGER');
    }

    const rows = database.prepare(
      `SELECT id, github_repository_id FROM projects
       WHERE github_repository_id IS NOT NULL
       ORDER BY COALESCE(created_at, '') ASC, id ASC`,
    ).all() as ProjectRepositoryIdRow[];
    const retained = new Map<number, number>();
    const quarantine = database.prepare(
      `UPDATE projects
       SET github_repository_id = NULL,
           github_installation_id = NULL,
           github_automation_enabled = 0
       WHERE id = ?`,
    );
    for (const row of rows) {
      const retainedId = retained.get(row.github_repository_id);
      if (retainedId === undefined) {
        retained.set(row.github_repository_id, row.id);
        continue;
      }
      quarantine.run(row.id);
      warnings.push(
        `[Migration] Disabled GitHub automation for project ${row.id}: repository ID ${row.github_repository_id} is retained by older project ${retainedId}`,
      );
    }

    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_github_repository_id
        ON projects(github_repository_id)
        WHERE github_repository_id IS NOT NULL;
    `);
  });

  migrate.immediate();
  for (const message of warnings) warn(message);
}

export function migrateGitHubFinalizationRuns(database: Database.Database): void {
  const migrate = database.transaction(() => {
    const columns = database.prepare('PRAGMA table_info(task_agent_runs)').all() as Array<{
      name: string;
    }>;
    const names = new Set(columns.map(({ name }) => name));
    const additions: ReadonlyArray<[string, string]> = [
      [
        'github_finalize_status',
        "TEXT NOT NULL DEFAULT 'none' CHECK (github_finalize_status IN ('none', 'ready', 'finalizing', 'finalized', 'failed'))",
      ],
      ['github_finalize_head_sha', 'TEXT'],
      ['github_finalize_error', 'TEXT'],
      ['github_finalize_started_at', 'DATETIME'],
    ];

    for (const [name, definition] of additions) {
      if (!names.has(name)) {
        database.exec(`ALTER TABLE task_agent_runs ADD COLUMN ${name} ${definition}`);
      }
    }
  });

  // IMMEDIATE serializes concurrent startup migrations before either process
  // inspects the column list, avoiding duplicate-column races.
  migrate.immediate();
}
