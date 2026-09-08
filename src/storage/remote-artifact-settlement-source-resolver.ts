import YAML from 'yaml';

import type { ArtifactIdentity } from '../domain/artifact-identity.js';
import { FileRemoteArtifactRepository } from './file-remote-artifact-repository.js';

export interface ResolvedArtifactSettlementSource {
  identity: ArtifactIdentity;
  content: string;
}

export interface ArtifactSettlementSourceResolver {
  resolve(artifact: ArtifactIdentity): Promise<ResolvedArtifactSettlementSource | null>;
}

function sameArtifactIdentity(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  return left.taskId === right.taskId
    && left.ref === right.ref
    && left.version === right.version
    && left.sha256 === right.sha256;
}

function renderRemoteRunOutput(input: {
  artifact: ArtifactIdentity;
  executionBindingReceiptId: string;
  runId: string;
  issueId: string;
  output: string;
  attachmentCount: number;
}): string {
  const frontmatter = YAML.stringify({
    type: 'remote_artifact',
    schema_version: 1,
    artifact_ref: input.artifact.ref,
    artifact_sha256: input.artifact.sha256,
    execution_binding_receipt_id: input.executionBindingReceiptId,
    run_id: input.runId,
    issue_id: input.issueId,
    attachment_count: input.attachmentCount,
    attachment_content_settled: false,
  });
  return [
    '---',
    frontmatter.trimEnd(),
    '---',
    '',
    '# Remote Artifact',
    '',
    input.output,
    '',
  ].join('\n');
}

export class RemoteArtifactSettlementSourceResolver
implements ArtifactSettlementSourceResolver {
  private readonly artifacts: FileRemoteArtifactRepository;

  constructor(runtimeRoot: string) {
    this.artifacts = new FileRemoteArtifactRepository(runtimeRoot);
  }

  async resolve(
    artifact: ArtifactIdentity,
  ): Promise<ResolvedArtifactSettlementSource | null> {
    const match = /^remote-artifact:\/\/(rar_[0-9a-f]{24})$/u.exec(artifact.ref);
    if (match?.[1] === undefined) return null;

    const production = await this.artifacts.readProductionEvidence(artifact.ref);
    if (!sameArtifactIdentity(production.identity, artifact)) return null;
    const receipt = await this.artifacts.get(match[1]);
    if (
      receipt === null
      || receipt.run.status !== 'completed'
      || receipt.run.completedAt === null
    ) return null;
    const outputs = receipt.sources.filter((source) => source.kind === 'run_output');
    if (outputs.length !== 1) return null;
    const output = outputs[0]!;
    return {
      identity: production.identity,
      content: renderRemoteRunOutput({
        artifact: production.identity,
        executionBindingReceiptId: production.executionBindingReceiptId,
        runId: production.runId,
        issueId: production.issueId,
        output: output.content,
        attachmentCount: receipt.sources.length - 1,
      }),
    };
  }
}
