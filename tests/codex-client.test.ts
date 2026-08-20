import assert from "node:assert/strict";
import test from "node:test";
import { codexAppServerArgs } from "../src/agent-access";
import { CODEX_REVIEW_DEVELOPER_INSTRUCTIONS } from "../src/anchors";
import {
  appServerEnvironment,
  buildTurnInput,
  CodexAppServerClient,
  CodexRpcError,
  codexReviewDeveloperInstructions,
  isActiveWriterConflict,
  skillMenuDescription,
  toUserFacingCodexError
} from "../src/codex-client";

test("enables live web search for every Codex App Server session", () => {
  assert.deepEqual(codexAppServerArgs(), ["app-server", "-c", 'web_search="live"']);
});

test("adds document policy to hidden Codex Review instructions", () => {
  const instructions = codexReviewDeveloperInstructions("Use the attached editorial policy.");
  assert.match(instructions, /Apply these rules silently/);
  assert.match(instructions, /Use the attached editorial policy/);
  assert.equal(codexReviewDeveloperInstructions(), CODEX_REVIEW_DEVELOPER_INSTRUCTIONS);
});

test("recognizes an App Server active-writer conflict", () => {
  const error = new CodexRpcError("thread abc already has an active writer");
  assert.equal(isActiveWriterConflict(error), true);
});

test("keeps unrelated App Server errors visible", () => {
  const error = new CodexRpcError("thread was not found");
  assert.equal(isActiveWriterConflict(error), false);
  assert.equal(toUserFacingCodexError(error), error);
});

test("explains that an occupied task keeps its existing binding", () => {
  const error = new CodexRpcError("thread abc already has an active writer");
  const reported = toUserFacingCodexError(error);

  assert.match(reported.message, /сохранил прежнюю задачу и комментарии/i);
  assert.doesNotMatch(reported.message, /новую задачу/i);
});

test("uses the short Codex skill description in the mention menu", () => {
  assert.equal(skillMenuDescription({
    shortDescription: "Короткое описание навыка",
    description: "Полное описание навыка. Оно занимает несколько строк и содержит подробные инструкции."
  }), "Короткое описание навыка");
  assert.equal(skillMenuDescription({
    description: "Первое предложение. Второе предложение с подробностями."
  }), "Первое предложение.");
});

test("starts a task with hidden Codex Review instructions", async () => {
  const client = new CodexAppServerClient("codex");
  const calls: Array<{ method: string; params: any }> = [];
  (client as any).connect = async () => undefined;
  (client as any).request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    return {};
  };

  await client.startThread("C:\\Vault", "Article", "gpt-5");

  assert.deepEqual(calls[0], {
    method: "thread/start",
    params: {
      cwd: "C:\\Vault",
      model: "gpt-5",
      approvalPolicy: "never",
      permissions: "obsidian-review",
      runtimeWorkspaceRoots: ["C:\\Vault"],
      developerInstructions: CODEX_REVIEW_DEVELOPER_INSTRUCTIONS
    }
  });
});

test("forks a task with its completed history and review permissions", async () => {
  const client = new CodexAppServerClient("codex");
  const calls: Array<{ method: string; params: unknown }> = [];
  (client as any).connect = async () => undefined;
  (client as any).request = async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === "thread/fork") return { thread: { id: "fork-1" } };
    return {};
  };

  const thread = await client.forkThread(
    "source-1",
    "C:\\Vault",
    "Article — копия",
    "gpt-5"
  );

  assert.equal(thread.id, "fork-1");
  assert.equal(thread.name, "Article — копия");
  assert.deepEqual(calls, [
    {
      method: "thread/fork",
      params: {
        threadId: "source-1",
        cwd: "C:\\Vault",
        model: "gpt-5",
        approvalPolicy: "never",
        permissions: "obsidian-review",
        runtimeWorkspaceRoots: ["C:\\Vault"],
        excludeTurns: true,
        deferGoalContinuation: true,
        developerInstructions: CODEX_REVIEW_DEVELOPER_INSTRUCTIONS
      }
    },
    {
      method: "thread/name/set",
      params: { threadId: "fork-1", name: "Article — копия" }
    }
  ]);
});

test("prefers classic PowerShell over packaged pwsh for the App Server", () => {
  const env = appServerEnvironment({
      LOCALAPPDATA: "C:\\TestHome\\AppData\\Local",
    Path: [
      "C:\\Tools",
      "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.4.0_x64__8wekyb3d8bbwe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
      "C:\\TestHome\\AppData\\Local\\Microsoft\\WindowsApps"
    ].join(";")
  }, "win32");

  assert.equal(
    env.Path,
    "C:\\Tools;C:\\Windows\\System32\\WindowsPowerShell\\v1.0"
  );
});

test("builds native Codex inputs for skills and local files", () => {
  assert.deepEqual(buildTurnInput(
    "Проверь документ",
    [
      { name: "draft.md", path: "C:\\Files\\draft.md" },
      { name: "diagram.png", path: "C:\\Files\\diagram.png" }
    ],
    [{ name: "stilizator", path: "C:\\Skills\\stilizator\\SKILL.md" }]
  ), [
    { type: "text", text: "Проверь документ", text_elements: [] },
    { type: "skill", name: "stilizator", path: "C:\\Skills\\stilizator\\SKILL.md" },
    { type: "mention", name: "draft.md", path: "C:\\Files\\draft.md" },
    { type: "localImage", path: "C:\\Files\\diagram.png" }
  ]);
});

test("sets and clears a native Codex task goal", async () => {
  const client = new CodexAppServerClient("codex");
  const calls: Array<{ method: string; params: unknown }> = [];
  (client as any).connect = async () => undefined;
  (client as any).request = async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === "thread/goal/set") {
      return { goal: { threadId: "thread-1", objective: "Подготовить статью", status: "active" } };
    }
    return {};
  };

  const goal = await client.setThreadGoal("thread-1", "Подготовить статью");
  await client.clearThreadGoal("thread-1");

  assert.equal(goal.objective, "Подготовить статью");
  assert.deepEqual(calls, [
    {
      method: "thread/goal/set",
      params: { threadId: "thread-1", objective: "Подготовить статью", status: "active" }
    },
    { method: "thread/goal/clear", params: { threadId: "thread-1" } }
  ]);
});

test("adds attachment folders to the turn workspace", async () => {
  const client = new CodexAppServerClient("codex");
  const calls: Array<{ method: string; params: any }> = [];
  (client as any).connect = async () => undefined;
  (client as any).request = async (method: string, params: any) => {
    calls.push({ method, params });
    return { turn: { id: "turn-1" } };
  };

  await client.sendToThread("thread-1", "C:\\Vault", "Прочитай файл", {
    resume: false,
    attachments: [{ name: "draft.md", path: "C:\\Files\\draft.md" }]
  });

  const turn = calls.find((call) => call.method === "turn/start");
  assert.deepEqual(turn?.params.runtimeWorkspaceRoots, ["C:\\Vault", "C:\\Files"]);
});

test("steers the active Codex turn with native attachments and skills", async () => {
  const client = new CodexAppServerClient("codex");
  const calls: Array<{ method: string; params: any }> = [];
  (client as any).connect = async () => undefined;
  (client as any).request = async (method: string, params: any) => {
    calls.push({ method, params });
    return { turnId: "turn-1" };
  };

  const result = await client.steerTurn("thread-1", "turn-1", "Учти уточнение", {
    attachments: [{ name: "note.md", path: "C:\\Files\\note.md" }],
    skills: [{ name: "stilizator", path: "C:\\Skills\\stilizator\\SKILL.md" }]
  });

  assert.equal(result.turnId, "turn-1");
  assert.deepEqual(calls, [{
    method: "turn/steer",
    params: {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [
        { type: "text", text: "Учти уточнение", text_elements: [] },
        { type: "skill", name: "stilizator", path: "C:\\Skills\\stilizator\\SKILL.md" },
        { type: "mention", name: "note.md", path: "C:\\Files\\note.md" }
      ]
    }
  }]);
});

test("applies hidden Codex Review instructions when resuming a task", async () => {
  const client = new CodexAppServerClient("codex");
  const calls: Array<{ method: string; params: any }> = [];
  (client as any).connect = async () => undefined;
  (client as any).request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    return {};
  };

  await client.sendToThread("thread-1", "C:\\Vault", "Review this comment");

  assert.deepEqual(calls[0], {
    method: "thread/resume",
    params: {
      threadId: "thread-1",
      developerInstructions: CODEX_REVIEW_DEVELOPER_INSTRUCTIONS
    }
  });
});

test("attaches current review context directly to a Codex turn", async () => {
  const client = new CodexAppServerClient("codex");
  const calls: Array<{ method: string; params: any }> = [];
  (client as any).connect = async () => undefined;
  (client as any).request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    return {};
  };

  await client.sendToThread("thread-1", "C:\\Vault", "Ты согласен?", {
    applicationContext: "Earlier branch: Claude answered with supporting sources."
  });

  const turn = calls.find((call) => call.method === "turn/start");
  assert.deepEqual(turn?.params.additionalContext, {
    "obsidian-agent-review": {
      kind: "application",
      value: "Earlier branch: Claude answered with supporting sources."
    }
  });
  assert.equal(turn?.params.input[0].text, "Ты согласен?");
});
