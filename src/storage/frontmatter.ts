import YAML from 'yaml';

export interface TaskDocument {
  data: Record<string, unknown>;
  body: string;
}

export class InvalidFrontmatterError extends Error {
  readonly code = 'invalid_frontmatter';

  constructor() {
    super('Invalid Markdown frontmatter');
    this.name = 'InvalidFrontmatterError';
  }
}

export function parseTaskDocument(raw: string): TaskDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)([\s\S]*)$/.exec(raw);
  if (match === null) {
    throw new InvalidFrontmatterError();
  }

  try {
    const parsed: unknown = YAML.parse(match[1] ?? '');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InvalidFrontmatterError();
    }

    return {
      data: parsed as Record<string, unknown>,
      body: match[2] ?? '',
    };
  } catch (error) {
    if (error instanceof InvalidFrontmatterError) {
      throw error;
    }
    throw new InvalidFrontmatterError();
  }
}

export function serializeTaskDocument(
  data: Record<string, unknown>,
  body: string,
): string {
  return `---\n${YAML.stringify(data)}---${body}`;
}
