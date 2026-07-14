import type { Task } from '../domain/task.js';
import type { ContextBundle } from './context-bundle.js';
import type { ResearchResult } from './result-contract.js';

export interface ResearchDriverInput {
  task: Task;
  context: ContextBundle;
  timeoutMs: number;
}

export interface ResearchDriver {
  readonly name: string;
  execute(input: ResearchDriverInput): Promise<ResearchResult>;
}
