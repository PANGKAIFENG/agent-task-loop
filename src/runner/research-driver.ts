import type { Task } from '../domain/task.js';
import type { ContextBundle } from './context-bundle.js';
import type { ExecutionProfile } from './execution-profile.js';
import type { DriverResult } from './result-contract.js';

export interface ResearchDriverInput {
  task: Task;
  context: ContextBundle;
  profile: ExecutionProfile;
  timeoutMs: number;
}

export interface ResearchDriver {
  readonly name: string;
  execute(input: ResearchDriverInput): Promise<DriverResult>;
}
