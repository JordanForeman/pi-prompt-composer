import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  composeRuntimePrompt,
  formatCompositionSummary,
  discoverSkillEntries,
  evaluateDetection,
  parseSkillFrontmatter,
  type Classifier,
} from "../src/core.ts";

async function writeSkill(root: string, relativePath: string, frontmatter: string, body: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
  return filePath;
}

test("parseSkillFrontmatter handles prompt-composer metadata", () => {
  const frontmatter = parseSkillFrontmatter(`---
name: typescript
description: TypeScript guidance
injection: detect
detect:
  files: [package.json, tsconfig.json]
  mode: write
---

Body`);

  assert.deepEqual(frontmatter, {
    name: "typescript",
    description: "TypeScript guidance",
    injection: "detect",
    detect: {
      files: ["package.json", "tsconfig.json"],
      mode: "write",
    },
  });
});

test("discoverSkillEntries scans SKILL.md files and applies default/custom priority", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-composer-discovery-"));
  const corePath = await writeSkill(
    root,
    "conventions/core/SKILL.md",
    "name: core\ndescription: Core rules\ninjection: always",
    "Core body",
  );
  await writeSkill(
    root,
    "conventions/typescript/SKILL.md",
    "name: typescript\ndescription: TypeScript\ninjection: detect\npriority: 0.8",
    "TypeScript body",
  );
  await writeSkill(
    root,
    "guides/private/SKILL.md",
    "name: private\ndescription: Manual only\ninjection: explicit",
    "Private body",
  );

  const entries = await discoverSkillEntries({ roots: [root] });

  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, "core");
  assert.equal(entries[0].filePath, corePath);
  assert.equal(entries[0].relativePath, "conventions/core/SKILL.md");
  assert.equal(entries[0].priority, 1.0);
  assert.equal(entries[1].priority, 0.8);
});

test("discoverSkillEntries preserves candidate relative paths for loaded Pi skills", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-composer-loaded-skill-"));
  const filePath = await writeSkill(
    root,
    "conventions/core/SKILL.md",
    "name: core\ndescription: Core rules\ninjection: always",
    "Core body",
  );

  const entries = await discoverSkillEntries({
    skillFiles: [{ filePath, baseDir: path.dirname(filePath), relativePath: "conventions/core/SKILL.md" }],
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].relativePath, "conventions/core/SKILL.md");
});

test("evaluateDetection supports file, dependency, platform, and tool-mode rules", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "prompt-composer-detection-"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ dependencies: { react: "latest" } }), "utf8");
  const context = { cwd, platform: process.platform, activeTools: [], prompt: "" };

  assert.equal(evaluateDetection({ files: ["package.json"] }, context), true);
  assert.equal(evaluateDetection({ dependencies: ["react"] }, context), true);
  assert.equal(evaluateDetection({ platform: process.platform }, context), true);
  assert.equal(evaluateDetection({ mode: "write" }, { ...context, activeTools: ["read", "edit"] }), true);
  assert.equal(evaluateDetection({ mode: "read-only" }, { ...context, activeTools: ["read", "grep", "find"] }), true);
});

test("composeRuntimePrompt can select classify skills by detect rules before classification", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-composer-hybrid-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "prompt-composer-hybrid-cwd-"));
  await writeFile(path.join(cwd, "vitest.config.ts"), "export default {}", "utf8");
  await writeSkill(
    root,
    "standards/testing/SKILL.md",
    "name: testing\ndescription: Testing standards\ninjection: classify\ndetect:\n  files: [vitest.config.ts]",
    "Testing body",
  );

  const entries = await discoverSkillEntries({ roots: [root] });
  const result = await composeRuntimePrompt({
    skills: entries,
    context: { cwd, platform: process.platform, activeTools: ["read", "edit"], prompt: "change tests" },
  });

  assert.deepEqual(result.composition.selected.map((selection) => selection.relativePath), ["standards/testing/SKILL.md"]);
});

test("composeRuntimePrompt ranks selected skills by priority", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-composer-compose-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "prompt-composer-cwd-"));
  await writeFile(path.join(cwd, "tsconfig.json"), "{}", "utf8");

  await writeSkill(root, "conventions/core/SKILL.md", "name: core\ndescription: Core\ninjection: always", "Core body");
  await writeSkill(root, "conventions/typescript/SKILL.md", "name: typescript\ndescription: TS\ninjection: detect\ndetect:\n  files: [tsconfig.json]", "TypeScript body");
  await writeSkill(root, "standards/naming/SKILL.md", "name: naming\ndescription: Naming\ninjection: classify", "Naming body");

  const entries = await discoverSkillEntries({ roots: [root] });
  const classifier: Classifier = async () => ["standards/naming/SKILL.md"];

  const result = await composeRuntimePrompt({
    skills: entries,
    context: { cwd, platform: process.platform, activeTools: ["read", "edit"], prompt: "rename this" },
    classifier,
    maxInjectedChars: 1_000,
  });

  assert.match(result.text, /## Runtime guidance/);
  assert.match(result.text, /### conventions\/core\/SKILL.md\nCore body/);
  assert.match(result.text, /### standards\/naming\/SKILL.md\nNaming body/);
  assert.match(result.text, /### conventions\/typescript\/SKILL.md\nTypeScript body/);
  assert.deepEqual(result.composition.selected.map((s) => s.relativePath), [
    "conventions/core/SKILL.md",
    "standards/naming/SKILL.md",
    "conventions/typescript/SKILL.md",
  ]);
});

test("composeRuntimePrompt gates low-priority skills by relevance floor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-composer-floor-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "prompt-composer-floor-cwd-"));
  await writeFile(path.join(cwd, "tsconfig.json"), "{}", "utf8");

  await writeSkill(root, "conventions/core/SKILL.md", "name: core\ndescription: Core\ninjection: always", "Core body");
  await writeSkill(root, "conventions/typescript/SKILL.md", "name: typescript\ndescription: TS\ninjection: detect\ndetect:\n  files: [tsconfig.json]", "TypeScript body");
  await writeSkill(root, "standards/naming/SKILL.md", "name: naming\ndescription: Naming\ninjection: classify", "Naming body");

  const entries = await discoverSkillEntries({ roots: [root] });
  const classifier: Classifier = async () => ["standards/naming/SKILL.md"];

  const result = await composeRuntimePrompt({
    skills: entries,
    context: { cwd, platform: process.platform, activeTools: ["read", "edit"], prompt: "rename this" },
    classifier,
    relevanceFloor: 0.6,
  });

  assert.deepEqual(result.composition.selected.map((s) => s.relativePath), [
    "conventions/core/SKILL.md",
    "standards/naming/SKILL.md",
  ]);
  assert.equal(result.composition.gatedByFloor, 1);
  assert.equal(result.composition.relevanceFloor, 0.6);
  assert.equal(result.text.includes("TypeScript body"), false);
  assert.ok(formatCompositionSummary(result.composition).includes("relevance floor: 0.60 (gated 1)"));

  const highFloor = await composeRuntimePrompt({
    skills: entries,
    context: { cwd, platform: process.platform, activeTools: ["read", "edit"], prompt: "rename this" },
    classifier,
    relevanceFloor: 2,
  });
  assert.deepEqual(highFloor.composition.selected.map((s) => s.relativePath), ["conventions/core/SKILL.md"]);
  assert.equal(highFloor.composition.relevanceFloor, 1);

  const lowFloor = await composeRuntimePrompt({
    skills: entries,
    context: { cwd, platform: process.platform, activeTools: ["read", "edit"], prompt: "rename this" },
    classifier,
    relevanceFloor: -1,
  });
  assert.equal(lowFloor.composition.selected.length, 3);
  assert.equal(lowFloor.composition.relevanceFloor, 0);
});
