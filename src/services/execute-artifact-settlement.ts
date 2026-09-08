import {
  createArtifactSettlementReceipt,
  isValidArtifactSettlementAuthorization,
  isValidArtifactSettlementPlan,
  type ArtifactSettlementAuthorizationEvidence,
  type ArtifactSettlementPlan,
  type ArtifactSettlementReceipt,
  type SettlementWriteResult,
} from '../domain/artifact-settlement.js';

export interface ExecuteArtifactSettlementResult {
  plan: ArtifactSettlementPlan | null;
  executed: boolean;
  receipt: ArtifactSettlementReceipt | null;
}

export interface ArtifactSettlementExecutionRepository {
  withLock?<T>(planId: string, operation: () => Promise<T>): Promise<T>;
  getPlan(planId: string): Promise<ArtifactSettlementPlan | null>;
  getAuthorization(
    planId: string,
  ): Promise<ArtifactSettlementAuthorizationEvidence | null>;
  getReceipt?(planId: string): Promise<ArtifactSettlementReceipt | null>;
  createReceipt?(receipt: ArtifactSettlementReceipt): Promise<void>;
}

export interface ExecuteArtifactSettlementDependencies {
  repository: ArtifactSettlementExecutionRepository;
  writer: (
    plan: ArtifactSettlementPlan,
    authorization: ArtifactSettlementAuthorizationEvidence,
  ) => Promise<SettlementWriteResult>;
  recoverUnknown?: (
    plan: ArtifactSettlementPlan,
    receipt: ArtifactSettlementReceipt,
    authorization: ArtifactSettlementAuthorizationEvidence,
  ) => Promise<SettlementWriteResult>;
  clock?: () => Date;
}

export async function executeArtifactSettlement(
  planId: string,
  dependencies: ExecuteArtifactSettlementDependencies,
): Promise<ExecuteArtifactSettlementResult> {
  if (planId.trim() === '') {
    return { plan: null, executed: false, receipt: null };
  }
  const plan = await dependencies.repository.getPlan(planId);
  if (plan === null || plan.planId !== planId) {
    return { plan, executed: false, receipt: null };
  }
  if (!isValidArtifactSettlementPlan(plan) || plan.state !== 'ready') {
    return { plan, executed: false, receipt: null };
  }
  const authorization = await dependencies.repository.getAuthorization(planId);
  if (
    authorization === null
    || !isValidArtifactSettlementAuthorization(authorization, plan)
  ) {
    return { plan, executed: false, receipt: null };
  }
  const executeLegacy = async (): Promise<ExecuteArtifactSettlementResult> => {
    const result = await dependencies.writer(plan, authorization);
    return {
      plan,
      executed: true,
      receipt: createArtifactSettlementReceipt(
        plan,
        result,
        (dependencies.clock ?? (() => new Date()))().toISOString(),
      ),
    };
  };
  if (
    dependencies.repository.withLock === undefined
    || dependencies.repository.getReceipt === undefined
    || dependencies.repository.createReceipt === undefined
  ) return executeLegacy();

  return dependencies.repository.withLock(planId, async () => {
    const lockedPlan = await dependencies.repository.getPlan(planId);
    const lockedAuthorization = await dependencies.repository.getAuthorization(planId);
    if (
      lockedPlan === null
      || lockedAuthorization === null
      || !isValidArtifactSettlementPlan(lockedPlan)
      || !isValidArtifactSettlementAuthorization(lockedAuthorization, lockedPlan)
    ) {
      return { plan: lockedPlan, executed: false, receipt: null };
    }
    const current = await dependencies.repository.getReceipt!(planId);
    if (current !== null) {
      if (current.status !== 'unknown' || dependencies.recoverUnknown === undefined) {
        return { plan: lockedPlan, executed: false, receipt: current };
      }
      let recovered: SettlementWriteResult;
      try {
        recovered = await dependencies.recoverUnknown(
          lockedPlan,
          current,
          lockedAuthorization,
        );
      } catch {
        return { plan: lockedPlan, executed: false, receipt: current };
      }
      if (recovered.status === 'unknown') {
        return { plan: lockedPlan, executed: false, receipt: current };
      }
      const receipt = createArtifactSettlementReceipt(
        lockedPlan,
        recovered,
        (dependencies.clock ?? (() => new Date()))().toISOString(),
      );
      await dependencies.repository.createReceipt!(receipt);
      return { plan: lockedPlan, executed: false, receipt };
    }

    const intent = createArtifactSettlementReceipt(
      lockedPlan,
      { status: 'unknown', writes: [] },
      (dependencies.clock ?? (() => new Date()))().toISOString(),
    );
    await dependencies.repository.createReceipt!(intent);
    let result: SettlementWriteResult;
    try {
      result = await dependencies.writer(lockedPlan, lockedAuthorization);
    } catch {
      return { plan: lockedPlan, executed: true, receipt: intent };
    }
    if (result.status === 'unknown') {
      return { plan: lockedPlan, executed: true, receipt: intent };
    }
    const receipt = createArtifactSettlementReceipt(
      lockedPlan,
      result,
      (dependencies.clock ?? (() => new Date()))().toISOString(),
    );
    await dependencies.repository.createReceipt!(receipt);
    return { plan: lockedPlan, executed: true, receipt };
  });
}
