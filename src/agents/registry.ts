import { loadAgentDirs, type AgentDir } from './config.ts';

export class AgentRegistry {
  private dirs: AgentDir[];

  constructor() {
    this.dirs = loadAgentDirs();
  }

  all(): AgentDir[] {
    return this.dirs;
  }

  statusDirs(): string[] {
    return this.dirs.map((d) => d.statusDir);
  }
}
