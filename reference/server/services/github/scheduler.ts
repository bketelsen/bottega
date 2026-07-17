import { projectsDb } from '../../database/db.js';
import { reconcileRepository } from './reconcile.js';
import { isTransientGitHubError, summarizeGitHubError } from './client.js';

interface SchedulableProject {
  id: number;
  github_repo?: string | null;
  github_automation_enabled?: boolean | number;
}

interface SchedulerOptions {
  intervalMs?: number;
  staggerMs?: number;
  listProjects?: () => SchedulableProject[];
  reconcile?: (projectId: number) => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

function configuredInterval(): number {
  const value = Number(process.env.GITHUB_RECONCILE_INTERVAL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_INTERVAL_MS;
}

export class GitHubRecoveryScheduler {
  private readonly intervalMs: number;
  private readonly staggerMs: number;
  private readonly listProjects: () => SchedulableProject[];
  private readonly reconcile: (projectId: number) => Promise<void>;
  private interval: NodeJS.Timeout | undefined;
  private timers = new Set<NodeJS.Timeout>();
  private scheduled = new Set<number>();
  private inFlight = new Map<number, Promise<void>>();
  private running = false;

  constructor(options: SchedulerOptions = {}) {
    this.intervalMs = options.intervalMs ?? configuredInterval();
    this.staggerMs = options.staggerMs ?? 1_000;
    this.listProjects = options.listProjects ?? (() => projectsDb.getGithubAutomationEnabled());
    this.reconcile = options.reconcile ?? reconcileRepository;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleEnabledProjects();
    this.interval = setInterval(() => this.scheduleEnabledProjects(), this.intervalMs);
  }

  private scheduleEnabledProjects(): void {
    if (!this.running) return;
    const projects = this.listProjects().filter(
      (project) => project.github_repo && project.github_automation_enabled,
    );
    projects.forEach((project, index) => {
      if (this.scheduled.has(project.id) || this.inFlight.has(project.id)) return;
      this.scheduled.add(project.id);
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.scheduled.delete(project.id);
        if (!this.running || this.inFlight.has(project.id)) return;

        const run = this.reconcile(project.id)
          .catch((error: unknown) => {
            if (isTransientGitHubError(error)) {
              console.warn(
                `[GitHub Scheduler] Project ${project.id} scan skipped (transient): ${summarizeGitHubError(error)}`,
              );
            } else {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`[GitHub Scheduler] Project ${project.id} scan failed:`, message);
            }
          })
          .finally(() => this.inFlight.delete(project.id));
        this.inFlight.set(project.id, run);
      }, index * this.staggerMs);
      this.timers.add(timer);
    });
  }

  stop(): void {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.scheduled.clear();
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()]);
  }
}

export const githubRecoveryScheduler = new GitHubRecoveryScheduler();
