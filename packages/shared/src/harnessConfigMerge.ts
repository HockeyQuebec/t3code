// Merge a global .agent-harness.toml with a repository's own, at the text
// level. Pure TypeScript module - no filesystem, process spawning, or Effect.
//
// Why text and not parse-then-serialize: the config is hand-written and full of
// multi-line prompts, comments, and ordering that explains itself. Re-emitting
// it from a parsed model would lose all of that, and the file is handed
// straight to agent-harness, which parses it with a real TOML parser — so
// anything we write has to survive that, not just our own reader.
//
// The unit of override is one table: `[agents.foo]` or `[workflows.bar]` and
// everything nested beneath it. A repository that names a workflow the global
// config also names replaces it whole; a repository that names a new one adds
// it. Neither file has to know about the other.

export interface HarnessConfigMergeResult {
  /** The merged document, ready to hand to agent-harness. */
  readonly toml: string;
  /** Table keys the repository replaced, e.g. `workflows.claude_team`. */
  readonly overridden: ReadonlyArray<string>;
  /** Table keys only the repository defines. */
  readonly added: ReadonlyArray<string>;
}

interface TableBlock {
  /** Override key: `agents.x` / `workflows.x`, or the full path otherwise. */
  readonly key: string;
  readonly lines: ReadonlyArray<string>;
}

interface SplitDocument {
  /** Everything before the first table header, e.g. `version = 1`. */
  readonly preamble: ReadonlyArray<string>;
  /** True when the preamble carries a key, not just comments and blank lines. */
  readonly preambleHasKeys: boolean;
  readonly blocks: ReadonlyArray<TableBlock>;
}

/**
 * Split dotted TOML key path segments, leaving quoted segments intact so a key
 * like `["my.agent"]` stays one segment.
 */
function splitKeyPath(header: string): ReadonlyArray<string> {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (const char of header) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ".") {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current.trim());
  return segments.filter((segment) => segment.length > 0);
}

/** `[workflows.x.nodes.plan]` and `[workflows.x]` share the key `workflows.x`. */
function overrideKey(path: ReadonlyArray<string>): string {
  const root = path[0];
  if ((root === "agents" || root === "workflows") && path.length >= 2) {
    return `${root}.${path[1]}`;
  }
  return path.join(".");
}

/**
 * The header path of a table line, or null when the line is not a header.
 * Handles both `[table]` and `[[array of tables]]`.
 */
function headerPath(line: string): ReadonlyArray<string> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[")) return null;
  const isArray = trimmed.startsWith("[[");
  const open = isArray ? 2 : 1;
  const close = trimmed.indexOf(isArray ? "]]" : "]", open);
  if (close === -1) return null;
  const path = splitKeyPath(trimmed.slice(open, close));
  return path.length > 0 ? path : null;
}

/** Count of unescaped `"""` / `'''` delimiters, to track multi-line strings. */
function countDelimiters(line: string, delimiter: string): number {
  let count = 0;
  let index = line.indexOf(delimiter);
  while (index !== -1) {
    count += 1;
    index = line.indexOf(delimiter, index + delimiter.length);
  }
  return count;
}

function splitDocument(text: string): SplitDocument {
  const preamble: string[] = [];
  const blocks: TableBlock[] = [];
  let current: { key: string; lines: string[] } | null = null;
  // A `[` inside a multi-line prompt is text, not a table header.
  let openDelimiter: '"""' | "'''" | null = null;

  for (const line of text.split("\n")) {
    if (openDelimiter === null) {
      const path = headerPath(line);
      if (path !== null) {
        if (current !== null) blocks.push(current);
        current = { key: overrideKey(path), lines: [line] };
      } else if (current !== null) {
        current.lines.push(line);
      } else {
        preamble.push(line);
      }
    } else if (current !== null) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }

    if (openDelimiter === null) {
      const triples = countDelimiters(line, '"""');
      const singles = countDelimiters(line, "'''");
      if (triples % 2 === 1) openDelimiter = '"""';
      else if (singles % 2 === 1) openDelimiter = "'''";
    } else if (countDelimiters(line, openDelimiter) % 2 === 1) {
      openDelimiter = null;
    }
  }
  if (current !== null) blocks.push(current);

  const preambleHasKeys = preamble.some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#") && trimmed.includes("=");
  });

  return { preamble, preambleHasKeys, blocks };
}

function trimBlankEdges(lines: ReadonlyArray<string>): ReadonlyArray<string> {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(start, end);
}

/**
 * Merge a global config with a repository's, the repository winning table by
 * table. Either side may be empty text, in which case the other is returned
 * unchanged.
 */
export function mergeHarnessConfigText(
  globalToml: string,
  repositoryToml: string,
): HarnessConfigMergeResult {
  if (repositoryToml.trim().length === 0) {
    return { toml: globalToml, overridden: [], added: [] };
  }
  if (globalToml.trim().length === 0) {
    return { toml: repositoryToml, overridden: [], added: [] };
  }

  const globalDocument = splitDocument(globalToml);
  const repository = splitDocument(repositoryToml);

  const repositoryKeys = new Set(repository.blocks.map((block) => block.key));
  const globalKeys = new Set(globalDocument.blocks.map((block) => block.key));

  const overridden: string[] = [];
  for (const key of repositoryKeys) {
    if (globalKeys.has(key)) overridden.push(key);
  }
  const added = Array.from(repositoryKeys).filter((key) => !globalKeys.has(key));

  // Only one preamble may survive: both files declare `version`, and a
  // duplicate top-level key is a hard error in a real TOML parser.
  const preamble = repository.preambleHasKeys ? repository.preamble : globalDocument.preamble;

  const sections: string[] = [];
  const pushBlock = (lines: ReadonlyArray<string>) => {
    const trimmed = trimBlankEdges(lines);
    if (trimmed.length > 0) sections.push(trimmed.join("\n"));
  };

  pushBlock(preamble);
  sections.push(
    `# --- inherited from the global agent-harness config ---\n` +
      `# Tables the repository redefines are omitted here; its own follow below.`,
  );
  for (const block of globalDocument.blocks) {
    if (!repositoryKeys.has(block.key)) pushBlock(block.lines);
  }
  sections.push(`# --- from this repository's config ---`);
  for (const block of repository.blocks) {
    pushBlock(block.lines);
  }

  return {
    toml: `${sections.join("\n\n")}\n`,
    overridden: overridden.sort(),
    added: added.sort(),
  };
}
