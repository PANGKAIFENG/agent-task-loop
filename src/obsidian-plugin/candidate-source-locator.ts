const MAX_SOURCE_CANDIDATES = 500;

export interface CandidateSourceFile {
  path: string;
}

export interface LocateMovedCandidateSourceInput<TFile extends CandidateSourceFile> {
  sourceKey: string;
  files: readonly TFile[];
  metadataFor(file: TFile): Record<string, unknown> | null | undefined;
}

export async function locateMovedCandidateSource<TFile extends CandidateSourceFile>(
  input: LocateMovedCandidateSourceInput<TFile>,
): Promise<string | null> {
  const sourceKey = input.sourceKey.trim().slice(0, 300);
  if (sourceKey === '' || input.files.length > MAX_SOURCE_CANDIDATES) return null;

  const matches = input.files.filter((file) => {
    const metadata = input.metadataFor(file);
    return metadata?.source_key === sourceKey || metadata?.sourceKey === sourceKey;
  });
  return matches.length === 1 ? matches[0]!.path : null;
}
