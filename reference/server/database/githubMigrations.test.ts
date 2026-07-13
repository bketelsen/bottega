import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enforceGitHubIdentityConstraints } from './githubMigrations.js';

describe('enforceGitHubIdentityConstraints', () => {
  let database: Database.Database;

  beforeEach(() => {
    database = new Database(':memory:');
    database.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        github_repo TEXT,
        github_automation_enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        github_issue_number INTEGER,
        github_pr_number INTEGER,
        created_at TEXT
      );
      CREATE TABLE task_agent_runs (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT,
        completed_at TEXT
      );
    `);
  });

  afterEach(() => database.close());

  it('quarantines legacy collisions and creates all identity indexes idempotently', () => {
    database.exec(`
      INSERT INTO projects VALUES
        (1, 'Owner/Repo', 1, '2026-01-01'),
        (2, 'https://github.com/owner/repo.git', 1, '2026-01-02'),
        (3, 'other/valid', 1, '2026-01-03'),
        (4, 'not a repository', 1, '2026-01-04');
      INSERT INTO tasks VALUES
        (10, 1, 7, 20, '2026-01-01'),
        (11, 1, 7, NULL, '2026-01-02'),
        (12, 1, NULL, 20, '2026-01-03'),
        (13, 1, 8, 21, '2026-01-04');
      INSERT INTO task_agent_runs VALUES
        (100, 10, 'running', '2026-01-01', NULL),
        (101, 10, 'running', '2026-01-02', NULL),
        (102, 10, 'running', '2026-01-02', NULL),
        (103, 11, 'running', '2026-01-01', NULL);
    `);
    const warn = vi.fn();

    enforceGitHubIdentityConstraints(database, warn);
    enforceGitHubIdentityConstraints(database, warn);

    expect(database.prepare(
      'SELECT id, github_repo, github_automation_enabled FROM projects ORDER BY id',
    ).all()).toEqual([
      { id: 1, github_repo: 'owner/repo', github_automation_enabled: 1 },
      { id: 2, github_repo: null, github_automation_enabled: 0 },
      { id: 3, github_repo: 'other/valid', github_automation_enabled: 1 },
      { id: 4, github_repo: null, github_automation_enabled: 0 },
    ]);
    expect(database.prepare(
      'SELECT id, github_issue_number, github_pr_number FROM tasks ORDER BY id',
    ).all()).toEqual([
      { id: 10, github_issue_number: 7, github_pr_number: 20 },
      { id: 11, github_issue_number: null, github_pr_number: null },
      { id: 12, github_issue_number: null, github_pr_number: null },
      { id: 13, github_issue_number: 8, github_pr_number: 21 },
    ]);
    const agentRuns = database.prepare(
      'SELECT id, status, completed_at FROM task_agent_runs ORDER BY id',
    ).all() as Array<{ id: number; status: string; completed_at: string | null }>;
    expect(agentRuns.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 100, status: 'failed' },
      { id: 101, status: 'failed' },
      { id: 102, status: 'running' },
      { id: 103, status: 'running' },
    ]);
    expect(agentRuns[0]!.completed_at).not.toBeNull();
    expect(agentRuns[1]!.completed_at).not.toBeNull();
    expect(agentRuns[2]!.completed_at).toBeNull();
    expect(agentRuns[3]!.completed_at).toBeNull();

    const indexes = database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name LIKE 'idx_%'
       ORDER BY name`,
    ).all() as Array<{ name: string }>;
    expect(indexes.map(({ name }) => name)).toEqual([
      'idx_projects_github_repo',
      'idx_task_agent_runs_one_running',
      'idx_tasks_github_issue',
      'idx_tasks_github_pr',
    ]);
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it('rolls back quarantine updates when the migration cannot finish', () => {
    database.exec(`
      DROP TABLE tasks;
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER, created_at TEXT);
      INSERT INTO projects VALUES
        (1, 'Owner/Repo', 1, '2026-01-01'),
        (2, 'owner/repo', 1, '2026-01-02');
    `);

    expect(() => enforceGitHubIdentityConstraints(database, vi.fn())).toThrow();
    expect(database.prepare(
      'SELECT id, github_repo, github_automation_enabled FROM projects ORDER BY id',
    ).all()).toEqual([
      { id: 1, github_repo: 'Owner/Repo', github_automation_enabled: 1 },
      { id: 2, github_repo: 'owner/repo', github_automation_enabled: 1 },
    ]);
    expect(database.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_projects_github_repo'`,
    ).get()).toBeUndefined();
  });
});
