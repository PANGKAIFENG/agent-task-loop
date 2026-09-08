import type { AdmissionVerdict } from '../domain/agent-admission.js';

export type AgentAdmissionDto = AdmissionVerdict;

export interface AdmissionTraceability {
  task_id: string;
  task_revision: string;
  project_id: string | null;
  context_pack_id: string | null;
  expected_artifact: string | null;
  acceptance_criteria: string[];
  source_key: string | null;
}

export type ProjectedAgentAdmission = AdmissionVerdict & {
  traceability?: AdmissionTraceability;
};

function cloneVerdict(
  verdict: AdmissionVerdict,
  traceability?: AdmissionTraceability,
): ProjectedAgentAdmission {
  return {
    ...verdict,
    reasons: verdict.reasons.map((reason) => ({ ...reason })),
    permission_gate: {
      ...verdict.permission_gate,
      external_writes: verdict.permission_gate.external_writes.map((write) => ({ ...write })),
    },
    ...(traceability === undefined
      ? {}
      : {
        traceability: {
          ...traceability,
          acceptance_criteria: [...traceability.acceptance_criteria],
        },
      }),
  };
}

export function projectAdmissionForWeb(
  verdict: AdmissionVerdict,
  traceability?: AdmissionTraceability,
): ProjectedAgentAdmission {
  return cloneVerdict(verdict, traceability);
}

export function projectAdmissionForObsidian(
  verdict: AdmissionVerdict,
  traceability?: AdmissionTraceability,
): ProjectedAgentAdmission {
  return cloneVerdict(verdict, traceability);
}
