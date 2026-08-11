import {
  prepareMaterialGap,
  type MaterialGap,
  type PrepareMaterialGapInput,
} from '../domain/material-gap.js';
import type { MaterialGapRepository } from '../storage/markdown-material-gap-repository.js';

export interface MaterialGapServiceContext {
  repository: MaterialGapRepository;
  clock: () => Date;
  id: () => string;
}

export type CreateMaterialGapInput = Omit<
  PrepareMaterialGapInput,
  'gapId' | 'createdAt'
>;

export async function createMaterialGap(
  context: MaterialGapServiceContext,
  input: CreateMaterialGapInput,
): Promise<MaterialGap> {
  const gap = prepareMaterialGap({
    ...input,
    gapId: context.id(),
    createdAt: context.clock().toISOString(),
  });
  return context.repository.create(gap);
}
