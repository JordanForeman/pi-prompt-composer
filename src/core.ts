import fs from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type InjectionType = "always" | "detect" | "classify" | "explicit";

export type DetectRules = {
  files?: string[];
  platform?: NodeJS.Platform | string;
  dependencies?: string[];
  mode?: "read-only" | "write";
};

export type SkillEntry = {
  category: string;
  name: string;
  description: string;
  injection: InjectionType;
  detect?: DetectRules;
  priority: number;
  filePath: string;
  relativePath: string;
  source?: string;
};

export type SkillFileCandidate = {
  filePath: string;
  baseDir?: string;
  source?: string;
  relativePath?: string;
  name?: string;
  description?: string;
};

export type FragmentSelection = {
  relativePath: string;
  filePath: string;
  reason: string;
  priority: number;
};

export type DetectionContext = {
  cwd: string;
  platform: NodeJS.Platform;
  activeTools: string[];
  prompt: string;
};

export type Composition = {
  cwd: string;
  platform: NodeJS.Platform;
  activeTools: string[];
  selected: FragmentSelection[];
  consideredCount: number;
  truncated: boolean;
  gatedByFloor: number;
  relevanceFloor: number;
  injectedChars: number;
  classifierUsed: boolean;
  classifierMs: number;
};

export type Classifier = (input: {
  prompt: string;
  skills: SkillEntry[];
  context: DetectionContext;
}) => Promise<string[]>;

export type DiscoverSkillEntriesOptions = {
  roots?: string[];
  skillFiles?: SkillFileCandidate[];
  includeExplicit?: boolean;
};

export type ComposeRuntimePromptOptions = {
  skills: SkillEntry[];
  context: DetectionContext;
  classifier?: Classifier;
  maxInjectedChars?: number;
  relevanceFloor?: number;
  sectionTitle?: string;
};

export const DEFAULT_MAX_INJECTED_CHARS = 20_000;
export const DEFAULT_PRIORITY: Record<InjectionType, number> = {
  always: 1.0,
  classify: 0.7,
  detect: 0.5,
  explicit: 0.5,
};
export const DEFAULT_SECTION_TITLE = "Runtime guidance (composed from skills)";

const skillBodyCache = new Map<string, string>();

export function parseSkillFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;

  for (const line of match[1].split("\n")) {
    if (line.trim() === "") continue;

    const nestedMatch = line.match(/^\s{2,}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nestedMatch && currentKey) {
      const parent = result[currentKey];
      if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
        result[currentKey] = {};
      }
      (result[currentKey] as Record<string, unknown>)[nestedMatch[1]] = parseYamlScalar(nestedMatch[2].trim());
      continue;
    }

    const topMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!topMatch) continue;

    currentKey = topMatch[1];
    const rawValue = topMatch[2].trim();
    result[currentKey] = rawValue === "" ? {} : parseYamlScalar(rawValue);
  }

  return result;
}

function parseYamlScalar(raw: string): string | string[] | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;

  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1);
    if (inner.trim() === "") return [];
    return inner.split(",").map((value) => stripQuotes(value.trim())).filter(Boolean);
  }

  return stripQuotes(raw);
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value.length > 0) return [value];
  return undefined;
}

function asInjectionType(value: unknown): InjectionType | undefined {
  if (value === "always" || value === "detect" || value === "classify" || value === "explicit") return value;
  return undefined;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function categoryFromRelativePath(relativePath: string): string {
  return relativePath.split("/")[0] ?? "skills";
}

function skillNameFromFilePath(filePath: string): string {
  return path.basename(path.dirname(filePath));
}

function detectRulesFromFrontmatter(frontmatter: Record<string, unknown>): DetectRules | undefined {
  const detect = frontmatter.detect;
  if (!detect || typeof detect !== "object" || Array.isArray(detect)) return undefined;

  const raw = detect as Record<string, unknown>;
  return {
    files: asStringArray(raw.files),
    platform: typeof raw.platform === "string" ? raw.platform : undefined,
    dependencies: asStringArray(raw.dependencies),
    mode: raw.mode === "read-only" || raw.mode === "write" ? raw.mode : undefined,
  };
}

function priorityFromFrontmatter(frontmatter: Record<string, unknown>, injection: InjectionType): number {
  const rawPriority = frontmatter.priority;
  const parsedPriority =
    typeof rawPriority === "number"
      ? rawPriority
      : typeof rawPriority === "string"
        ? Number.parseFloat(rawPriority)
        : Number.NaN;

  if (Number.isFinite(parsedPriority) && parsedPriority >= 0 && parsedPriority <= 1) {
    return parsedPriority;
  }

  return DEFAULT_PRIORITY[injection];
}

function clampRelevanceFloor(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export async function discoverSkillEntries(options: DiscoverSkillEntriesOptions): Promise<SkillEntry[]> {
  const candidates = await collectSkillFileCandidates(options);
  const entries: SkillEntry[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const filePath = path.resolve(candidate.filePath);
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    const content = await readTextFile(filePath);
    if (!content) continue;

    const frontmatter = parseSkillFrontmatter(content);
    if (!frontmatter) continue;

    const injection = asInjectionType(frontmatter.injection) ?? "explicit";
    if (injection === "explicit" && !options.includeExplicit) continue;

    const relativePath = candidate.relativePath
      ? normalizeRelativePath(candidate.relativePath)
      : candidate.baseDir
        ? normalizeRelativePath(path.relative(candidate.baseDir, filePath))
        : inferRelativeSkillPath(filePath, options.roots ?? []);

    entries.push({
      category: categoryFromRelativePath(relativePath),
      name: typeof frontmatter.name === "string" ? frontmatter.name : candidate.name ?? skillNameFromFilePath(filePath),
      description: typeof frontmatter.description === "string" ? frontmatter.description : candidate.description ?? "",
      injection,
      detect: detectRulesFromFrontmatter(frontmatter),
      priority: priorityFromFrontmatter(frontmatter, injection),
      filePath,
      relativePath,
      source: candidate.source,
    });
  }

  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function collectSkillFileCandidates(options: DiscoverSkillEntriesOptions): Promise<SkillFileCandidate[]> {
  const candidates = [...(options.skillFiles ?? [])];

  for (const root of options.roots ?? []) {
    const absoluteRoot = path.resolve(root);
    for (const filePath of await findSkillFiles(absoluteRoot)) {
      candidates.push({ filePath, baseDir: absoluteRoot, source: root });
    }
  }

  return candidates;
}

async function findSkillFiles(root: string): Promise<string[]> {
  if (!fs.existsSync(root)) return [];

  const results: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findSkillFiles(fullPath));
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      results.push(fullPath);
    }
  }

  return results;
}

function inferRelativeSkillPath(filePath: string, roots: string[]): string {
  const absolutePath = path.resolve(filePath);
  const matchingRoot = roots
    .map((root) => path.resolve(root))
    .filter((root) => absolutePath.startsWith(`${root}${path.sep}`))
    .sort((a, b) => b.length - a.length)[0];

  if (matchingRoot) return normalizeRelativePath(path.relative(matchingRoot, absolutePath));
  return normalizeRelativePath(path.basename(path.dirname(filePath)) + "/SKILL.md");
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export function evaluateDetection(rules: DetectRules | undefined, context: DetectionContext): boolean {
  if (!rules) return false;

  if (rules.platform && context.platform === rules.platform) return true;
  if (rules.mode === "read-only" && detectReadOnlyMode(context.activeTools)) return true;
  if (rules.mode === "write" && detectWriteMode(context.activeTools)) return true;
  if (rules.files && rules.files.length > 0 && hasAnyFile(context.cwd, rules.files)) return true;
  if (rules.dependencies && rules.dependencies.length > 0 && hasAnyDependency(context.cwd, rules.dependencies)) return true;

  return false;
}

function hasAnyFile(cwd: string, names: string[]): boolean {
  return names.some((name) => fs.existsSync(path.resolve(cwd, name)));
}

function hasAnyDependency(cwd: string, dependencies: string[]): boolean {
  const packageJson = loadPackageJson(cwd);
  if (!packageJson) return false;
  return dependencies.some((dependency) => hasDependency(packageJson, dependency));
}

function loadPackageJson(cwd: string): Record<string, unknown> | undefined {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!fs.existsSync(packageJsonPath)) return undefined;

  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function hasDependency(packageJson: Record<string, unknown>, dependency: string): boolean {
  const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  return fields.some((field) => {
    const value = packageJson[field];
    return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, dependency));
  });
}

function detectReadOnlyMode(activeTools: string[]): boolean {
  if (activeTools.length === 0) return false;
  const names = new Set(activeTools.map((tool) => tool.trim().toLowerCase()));
  const mutatingTools = ["bash", "edit", "write"];
  const hasKnownMutator = mutatingTools.some((tool) => names.has(tool));
  const hasGitMutator = Array.from(names).some((name) => /^(git|git[-_:].+|.*[-_:]git)$/.test(name));
  return !hasKnownMutator && !hasGitMutator;
}

function detectWriteMode(activeTools: string[]): boolean {
  if (activeTools.length === 0) return false;
  const names = new Set(activeTools.map((tool) => tool.trim().toLowerCase()));
  return names.has("bash") || names.has("edit") || names.has("write");
}

export async function composeRuntimePrompt(options: ComposeRuntimePromptOptions): Promise<{ text: string; composition: Composition }> {
  const maxInjectedChars = options.maxInjectedChars ?? DEFAULT_MAX_INJECTED_CHARS;
  const sectionTitle = options.sectionTitle ?? DEFAULT_SECTION_TITLE;
  const relevanceFloor = clampRelevanceFloor(options.relevanceFloor ?? 0);
  const { selected: collected, classifierUsed, classifierMs } = await collectSelections(options);
  const ranked = [...collected].sort((a, b) => b.priority - a.priority);
  const gated = ranked.filter((selection) => selection.priority >= relevanceFloor);
  const gatedByFloor = ranked.length - gated.length;
  const selected: FragmentSelection[] = [];
  const blocks: string[] = [];
  let currentChars = 0;
  let truncated = false;

  for (const candidate of gated) {
    const content = await loadSkillBody(candidate.filePath);
    if (!content) continue;

    const block = `### ${candidate.relativePath}\n${content}`;
    if (currentChars + block.length > maxInjectedChars) {
      truncated = true;
      continue;
    }

    blocks.push(block);
    selected.push(candidate);
    currentChars += block.length;
  }

  const truncationNote = truncated ? "\n\n_Note: additional skills were available but omitted to control prompt size._" : "";
  const text = blocks.length > 0 ? `## ${sectionTitle}\n\n${blocks.join("\n\n")}${truncationNote}` : "";

  return {
    text,
    composition: {
      cwd: options.context.cwd,
      platform: options.context.platform,
      activeTools: options.context.activeTools,
      selected,
      consideredCount: options.skills.length,
      truncated,
      gatedByFloor,
      relevanceFloor,
      injectedChars: currentChars,
      classifierUsed,
      classifierMs,
    },
  };
}

async function collectSelections(options: ComposeRuntimePromptOptions): Promise<{
  selected: FragmentSelection[];
  classifierUsed: boolean;
  classifierMs: number;
}> {
  const selected: FragmentSelection[] = [];
  const selectedIds = new Set<string>();

  const addSelection = (skill: SkillEntry, reason: string) => {
    const selectionKey = skill.filePath;
    if (selectedIds.has(selectionKey)) return;
    selectedIds.add(selectionKey);
    selected.push({ relativePath: skill.relativePath, filePath: skill.filePath, reason, priority: skill.priority });
  };

  for (const skill of options.skills) {
    if (skill.injection === "always") addSelection(skill, skill.description);
  }

  for (const skill of options.skills) {
    if ((skill.injection === "detect" || skill.injection === "classify") && evaluateDetection(skill.detect, options.context)) {
      addSelection(skill, skill.description);
    }
  }

  const classifySkills = options.skills.filter((skill) => skill.injection === "classify");
  if (!options.classifier || classifySkills.length === 0 || options.context.prompt.trim().length === 0) {
    return { selected, classifierUsed: false, classifierMs: 0 };
  }

  const start = performance.now();
  const classifiedIds = await options.classifier({
    prompt: options.context.prompt,
    skills: classifySkills,
    context: options.context,
  });
  const classifierMs = Math.round(performance.now() - start);
  const classifiedIdSet = new Set(classifiedIds);

  for (const skill of classifySkills) {
    if (classifiedIdSet.has(skill.relativePath)) {
      addSelection(skill, `Classifier: ${skill.description}`);
    }
  }

  return { selected, classifierUsed: true, classifierMs };
}

export async function loadSkillBody(filePath: string): Promise<string | undefined> {
  const absolutePath = path.resolve(filePath);
  const cached = skillBodyCache.get(absolutePath);
  if (cached) return cached;

  const raw = await readTextFile(absolutePath);
  if (!raw) return undefined;

  const body = raw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  skillBodyCache.set(absolutePath, body);
  return body;
}

export function defaultSkillRoots(cwd: string, agentDir = process.env.PI_CODING_AGENT_DIR): string[] {
  const resolvedAgentDir = agentDir ?? path.join(os.homedir(), ".pi", "agent");
  return [
    path.join(resolvedAgentDir, "skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(cwd, ".pi", "skills"),
    path.join(cwd, ".agents", "skills"),
  ];
}

export function formatCompositionSummary(composition: Composition): string[] {
  const lines = [
    `cwd: ${composition.cwd}`,
    `platform: ${composition.platform}`,
    `active tools: ${composition.activeTools.join(", ") || "(none)"}`,
    `skills discovered: ${composition.consideredCount}`,
    `skills injected: ${composition.selected.length}`,
    `prompt chars injected: ${composition.injectedChars}`,
    `truncated: ${composition.truncated ? "yes" : "no"}`,
  ];

  if (composition.relevanceFloor > 0) {
    lines.push(`relevance floor: ${composition.relevanceFloor.toFixed(2)} (gated ${composition.gatedByFloor})`);
  }

  if (composition.classifierUsed) {
    const classifiedCount = composition.selected.filter((selection) => selection.reason.startsWith("Classifier:")).length;
    lines.push(`classifier: ${classifiedCount} skills selected (${composition.classifierMs}ms)`);
  } else {
    lines.push("classifier: not used");
  }

  return lines;
}
