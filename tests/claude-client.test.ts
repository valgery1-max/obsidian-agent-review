import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyCodexNotification, createCodexActivity } from "../src/activity";
import {
  CLAUDE_REVIEW_ALLOWED_TOOLS,
  CLAUDE_REVIEW_DISALLOWED_TOOLS
} from "../src/agent-access";
import {
  ClaudeAgentClient,
  claudeAdditionalDirectories,
  claudeResourceInstructions,
  claudeReviewSystemPrompt,
  claudeSessionFile
} from "../src/claude-client";
import { parseThreadHistory } from "../src/history";

test("gives Claude file, skill resource, and web tools while keeping shell commands disabled", () => {
  assert.deepEqual([...CLAUDE_REVIEW_ALLOWED_TOOLS], [
    "Read", "Edit", "Write", "Glob", "Grep", "WebSearch", "WebFetch"
  ]);
  assert.deepEqual([...CLAUDE_REVIEW_DISALLOWED_TOOLS], ["Bash"]);
});

test("asks Claude for detailed comment replies and a completion-only chat report", () => {
  const prompt = claudeReviewSystemPrompt("Use the editorial policy.", "Prepare the article.");

  assert.match(prompt, /detailed and complete response inside the response field/i);
  assert.match(prompt, /confirm only that the batch was processed and per-comment responses are ready/i);
  assert.match(prompt, /Do not mention what you changed, found, concluded, or explained/i);
  assert.match(prompt, /Use the editorial policy/);
  assert.match(prompt, /Prepare the article/);
});

test("lists Claude sessions from every local project and restores their conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-review-claude-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const cwd = join(root, "Vault with notes");
    const otherCwd = join(root, "Other project");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(otherCwd, { recursive: true });
    const threadId = "11111111-2222-4333-8444-555555555555";
    const sessionPath = claudeSessionFile(cwd, threadId);
    mkdirSync(join(sessionPath, ".."), { recursive: true });
    writeFileSync(sessionPath, [
      {
        type: "user",
        uuid: "user-1",
        timestamp: "2026-08-13T10:00:00.000Z",
        message: { role: "user", content: "Проверьте этот документ" }
      },
      {
        type: "assistant",
        timestamp: "2026-08-13T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Сначала прочитаю файл" },
            { type: "text", text: "Документ проверен" }
          ]
        }
      }
    ].map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
    const otherSessionPath = claudeSessionFile(otherCwd, "66666666-7777-4888-8999-000000000000");
    mkdirSync(join(otherSessionPath, ".."), { recursive: true });
    writeFileSync(otherSessionPath, [
      {
        type: "user",
        uuid: "user-2",
        cwd: otherCwd,
        timestamp: "2026-08-13T11:00:00.000Z",
        message: { role: "user", content: "Соберите исследования" }
      },
      {
        type: "assistant",
        cwd: otherCwd,
        timestamp: "2026-08-13T11:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Исследования собраны" }] }
      }
    ].map((entry) => JSON.stringify(entry)).join("\n"), "utf8");

    const client = new ClaudeAgentClient("claude");
    const threads = await client.listThreads(cwd);
    assert.equal(threads.length, 2);
    assert.equal(threads[0].id, threadId);
    assert.equal(threads[0].cwd, cwd);
    assert.match(threads[0].name ?? "", /Проверьте этот документ/);
    assert.equal(threads[1].cwd, otherCwd);

    const history = parseThreadHistory(await client.readThread(threadId, cwd));
    assert.deepEqual(history.map((message) => [message.kind, message.text]), [
      ["user", "Проверьте этот документ"],
      ["reasoning", "Сначала прочитаю файл"],
      ["assistant", "Документ проверен"]
    ]);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("offers the Claude models supported by Claude Code", async () => {
  const models = await new ClaudeAgentClient("claude").listModels();

  assert.equal(models.find((model) => model.isDefault)?.model, "sonnet");
  assert.deepEqual(models.map((model) => model.model), ["sonnet", "opus", "fable"]);
});

test("lists only Claude user and project skills", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-review-claude-skills-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "profile");
  try {
    const cwd = join(root, "vault");
    const userSkill = join(process.env.CLAUDE_CONFIG_DIR, "skills", "user-editor");
    const projectSkill = join(cwd, ".claude", "skills", "project-editor");
    mkdirSync(userSkill, { recursive: true });
    mkdirSync(projectSkill, { recursive: true });
    writeFileSync(join(userSkill, "SKILL.md"), "---\ndescription: User editing rules.\n---\n", "utf8");
    writeFileSync(join(projectSkill, "SKILL.md"), "---\ndescription: Project editing rules.\n---\n", "utf8");

    const skills = await new ClaudeAgentClient("claude").listSkills(cwd);

    assert.deepEqual(skills.map((skill) => [skill.name, skill.scope]), [
      ["project-editor", "repo"],
      ["user-editor", "user"]
    ]);
    assert.equal(skills.some((skill) => skill.path.includes(".codex")), false);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("adds the Obsidian vault and attached resources to an external Claude task", () => {
  assert.deepEqual(claudeAdditionalDirectories({
    workspaceRoots: ["C:\\Vault"],
    attachments: [{ name: "policy.md", path: "C:\\References\\policy.md" }],
    skills: [{ name: "editor", path: "C:\\Skills\\editor\\SKILL.md" }]
  }), ["C:\\Vault", "C:\\References", "C:\\Skills\\editor"]);
});

test("places Claude attachment and skill paths in hidden turn instructions", () => {
  const resources = claudeResourceInstructions(
    [{ name: "policy.md", path: "C:\\References\\policy.md" }],
    [{ name: "editor", path: "C:\\Skills\\editor\\SKILL.md" }]
  );
  const prompt = claudeReviewSystemPrompt(undefined, undefined, resources);

  assert.match(prompt, /C:\\References\\policy\.md/);
  assert.match(prompt, /\$editor: C:\\Skills\\editor\\SKILL\.md/);
});

test("streams Claude answer as the final message without duplicating it in commentary", () => {
  const client = new ClaudeAgentClient("claude");
  const activity = createCodexActivity(
    "note.md",
    "thread-1",
    "Claude",
    { provider: "claude" },
    "2026-08-13T10:00:00.000Z"
  );
  activity.turnId = "turn-1";
  const stop = client.onNotification((notification) => {
    applyCodexNotification(activity, notification);
  });
  const blocks = new Map<number, { id: string; kind: "text" | "thinking" }>();
  const translate = (client as any).translate.bind(client);

  translate({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "text" } }
  }, "thread-1", "turn-1", blocks);
  translate({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Готово" } }
  }, "thread-1", "turn-1", blocks);
  translate({ type: "result", result: "Готово" }, "thread-1", "turn-1", blocks);
  stop();

  assert.equal(activity.finalMessage, "Готово");
  assert.deepEqual(activity.entries, []);
});
