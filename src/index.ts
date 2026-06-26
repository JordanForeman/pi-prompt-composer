import { completeSimple } from "@earendil-works/pi-ai";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  composeRuntimePrompt,
  defaultSkillRoots,
  discoverSkillEntries,
  formatCompositionSummary,
  loadSkillBody,
  type Classifier,
  type Composition,
  type DetectionContext,
  type SkillEntry,
  type SkillFileCandidate,
} from "./core.ts";

export * from "./core.ts";

export type ModelCandidate = {
  provider: string;
  id: string;
};

export type PromptComposerClassifierOptions = false | {
  modelCandidates?: ModelCandidate[];
  maxTokens?: number;
  temperature?: number;
};

export type PromptComposerOptions = {
  commandName?: string;
  statusKey?: string;
  sectionTitle?: string;
  maxInjectedChars?: number;
  skillRoots?: string[];
  includeLoadedSkills?: boolean;
  includeDefaultSkillRoots?: boolean;
  classifier?: PromptComposerClassifierOptions;
  relevanceFloor?: number;
  healthCheckpointType?: string | false;
};

const DEFAULT_MODEL_CANDIDATES: ModelCandidate[] = [
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "anthropic", id: "claude-3-5-haiku-latest" },
  { provider: "anthropic", id: "claude-3-5-haiku-20241022" },
];

const CLASSIFIER_SYSTEM_PROMPT = `You are a prompt fragment classifier for a coding assistant. Given a user's message, select which additional guidance fragments should be injected into the assistant's system prompt to improve its response quality.

You will receive a list of available fragments, each with an ID and a description of when it should be activated. Select only fragments that are clearly relevant to the user's current request. Prefer precision over recall — it is better to miss a marginally relevant fragment than to include irrelevant ones.

Respond with a JSON array of fragment IDs. If no fragments are relevant, respond with [].

Example response: ["conventions/code-security/SKILL.md", "guides/debugging/SKILL.md"]`;

const DEFAULT_HEALTH_CHECKPOINT_TYPE = "health-checkpoint";

export function createPromptComposer(options: PromptComposerOptions = {}) {
  return function promptComposer(pi: ExtensionAPI) {
    registerPromptComposer(pi, options);
  };
}

export function registerPromptComposer(pi: ExtensionAPI, options: PromptComposerOptions = {}) {
  const commandName = options.commandName ?? "prompt-debug";
  const statusKey = options.statusKey ?? "prompt-composer";
  let lastComposition: Composition | null = null;

  pi.registerCommand(commandName, {
    description: "Show active prompt-composer skills for the current repo/tool mode",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if (!lastComposition) {
        ctx.ui.notify("prompt-composer: no composition has been generated yet in this session.", "warning");
        return;
      }

      const showFull = (args ?? "").trim().toLowerCase() === "full";
      const lines = ["prompt-composer", ...formatCompositionSummary(lastComposition), "", "injected skills:"];

      if (lastComposition.selected.length === 0) {
        lines.push("- (none)");
      } else {
        for (const selection of lastComposition.selected) {
          lines.push(`- ${selection.relativePath}: ${selection.reason}`);
          if (showFull) {
            const content = await loadSkillBody(selection.filePath) ?? "(not loaded)";
            lines.push(`  ${content.replace(/\n/g, "\n  ")}`);
          }
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const skills = await discoverRuntimeSkills(event.systemPromptOptions, ctx, options);
    const context: DetectionContext = {
      cwd: ctx.cwd,
      platform: process.platform,
      activeTools: pi.getActiveTools(),
      prompt: event.prompt,
    };

    const relevanceFloor = options.relevanceFloor ?? readRelevanceFloor(ctx, options.healthCheckpointType);
    const result = await composeRuntimePrompt({
      skills,
      context,
      classifier: createRuntimeClassifier(ctx, options.classifier),
      maxInjectedChars: options.maxInjectedChars,
      relevanceFloor,
      sectionTitle: options.sectionTitle,
    });
    lastComposition = result.composition;

    if (ctx.hasUI) {
      const classifierNote = result.composition.classifierUsed ? ` (${result.composition.classifierMs}ms)` : "";
      ctx.ui.setStatus(
        statusKey,
        `🧩${result.composition.selected.length}/${result.composition.consideredCount}${classifierNote}`,
      );
    }

    if (!result.text) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${result.text}`,
    };
  });
}

async function discoverRuntimeSkills(
  systemPromptOptions: BuildSystemPromptOptions,
  ctx: ExtensionContext,
  options: PromptComposerOptions,
): Promise<SkillEntry[]> {
  const roots = [
    ...(options.skillRoots ?? []),
    ...(options.includeDefaultSkillRoots === true ? defaultSkillRoots(ctx.cwd) : []),
  ];

  return discoverSkillEntries({
    roots,
    skillFiles: options.includeLoadedSkills === false ? [] : skillCandidatesFromSystemPromptOptions(systemPromptOptions),
  });
}

function skillCandidatesFromSystemPromptOptions(options: BuildSystemPromptOptions): SkillFileCandidate[] {
  const candidates: SkillFileCandidate[] = [];

  for (const skill of options.skills ?? []) {
    candidates.push({
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      source: skill.sourceInfo.source,
      name: skill.name,
      description: skill.description,
      relativePath: inferLoadedSkillRelativePath(skill.filePath, skill.name),
    });
  }

  return candidates;
}

function inferLoadedSkillRelativePath(filePath: string, skillName: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const skillsIndex = parts.lastIndexOf("skills");

  if (skillsIndex >= 0 && skillsIndex < parts.length - 1) {
    return parts.slice(skillsIndex + 1).join("/");
  }

  return `${skillName}/SKILL.md`;
}

export function readRelevanceFloor(ctx: ExtensionContext, healthCheckpointType: string | false | undefined = DEFAULT_HEALTH_CHECKPOINT_TYPE): number {
  if (healthCheckpointType === false) return 0;

  const checkpointType = healthCheckpointType ?? DEFAULT_HEALTH_CHECKPOINT_TYPE;
  const entries = ctx.sessionManager.getEntries();

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; customType?: string; data?: { relevanceFloor?: unknown } };
    if (entry.type !== "custom" || entry.customType !== checkpointType) continue;

    const floor = entry.data?.relevanceFloor;
    return typeof floor === "number" && floor >= 0 && floor <= 1 ? floor : 0;
  }

  return 0;
}

function createRuntimeClassifier(ctx: ExtensionContext, classifierOptions: PromptComposerClassifierOptions | undefined): Classifier | undefined {
  if (!classifierOptions) return undefined;
  return async ({ prompt, skills }) => {
    const candidates = classifierOptions.modelCandidates ?? DEFAULT_MODEL_CANDIDATES;
    const model = candidates.reduce<ReturnType<typeof ctx.modelRegistry.find>>(
      (found, candidate) => found ?? ctx.modelRegistry.find(candidate.provider, candidate.id),
      undefined,
    );
    if (!model) return [];

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return [];

    const fragmentList = skills.map((skill) => `- ${skill.relativePath}: "${skill.description}"`).join("\n");
    const userMessage = `Available fragments:\n${fragmentList}\n\nUser message:\n${prompt}`;

    try {
      const result = await completeSimple(model, {
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
      }, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: classifierOptions.maxTokens ?? 256,
        temperature: classifierOptions.temperature ?? 0,
      });

      const text = result.content
        .filter((content): content is { type: "text"; text: string } => content.type === "text")
        .map((content) => content.text)
        .join("");
      const jsonMatch = text.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      const validIds = new Set(skills.map((skill) => skill.relativePath));
      return parsed.filter((id): id is string => typeof id === "string" && validIds.has(id));
    } catch {
      return [];
    }
  };
}

export default createPromptComposer();
