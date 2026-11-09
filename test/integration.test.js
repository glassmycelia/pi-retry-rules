import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAssistantMessageEventStream, streamSimpleOpenAICompletions } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, parseConfig, RETRY_HINT } from "../rules.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const error = 'test-provider API error (400): {"code":null,"message":"temporary upstream rejection","param":null,"type":"invalid_request_error"}';
const testConfig = { enabled: true, language: "en", rules: [{ provider: "test-provider", model: "test-model",
  contains: ["(400)", "temporary upstream rejection", "invalid_request_error"] }] };

async function setup(t, { responses = ["failure", "success"], retry = {}, config, sessionManager, persistent = false, uiContext, providerGate,
  serializedProvider = false, fileSettings = false, projectTrusted = true, useDefaultConfig = false, extensionPath = join(root, "index.js") } = {}) {
  config = config === undefined ? structuredClone(testConfig) : config;
  const dir = await mkdtemp(join(tmpdir(), "pi-retry-rules-"));
  const initialSettings = { compaction: { enabled: false }, cacheWarming: "off",
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 10, ...retry } };
  if (fileSettings) await writeFile(join(dir, "settings.json"), JSON.stringify(initialSettings));
  const settingsManager = fileSettings ? SettingsManager.create(dir, dir, { projectTrusted })
    : SettingsManager.inMemory(initialSettings, { projectTrusted });
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models-store.json"), refreshOnCreate: false });
  const requests = [];
  const payloads = [];
  const hookedPayloads = [];
  let toolRuns = 0;
  runtime.registerProvider("test-provider", {
    baseUrl: "http://unused.invalid", api: "openai-completions", apiKey: "mock-test-key",
    models: [{ id: "test-model", name: "Mock", reasoning: false, input: ["text"],
      contextWindow: 100000, maxTokens: 1000, compat: { supportsFinishReason: true }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, context, options) => {
      requests.push(structuredClone(context.messages));
      const response = responses[Math.min(requests.length - 1, responses.length - 1)];
      if (serializedProvider) {
        return streamSimpleOpenAICompletions(model, context, { ...options,
          fetch: async (input, init) => {
            payloads.push(JSON.parse(await new Request(input, init).text()));
            await providerGate?.(requests.length);
            if (response === "failure") return new Response(JSON.stringify({ error: JSON.parse(error.slice(error.indexOf("{"))) }),
              { status: 400, headers: { "content-type": "application/json" } });
            const choice = response === "tool"
              ? { delta: { role: "assistant", tool_calls: [{ index: 0, id: "already-completed", type: "function",
                function: { name: "once", arguments: "{}" } }] }, finish_reason: "tool_calls" }
              : { delta: { role: "assistant", content: response === "partial" ? "partial-not-for-replay" : "Success" },
                finish_reason: response === "partial" ? null : "stop" };
            const data = { id: "mock", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, ...choice }] };
            const sse = `data: ${JSON.stringify(data)}\n\n`;
            if (response === "partial") {
              let sent = false;
              return new Response(new ReadableStream({ pull(controller) {
                if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(sse)); }
                else controller.error(new Error("Mock stream interrupted"));
              } }), { headers: { "content-type": "text/event-stream" } });
            }
            return new Response(`${sse}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
          } });
      }
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
        content: [], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(async () => {
        await providerGate?.(requests.length);
        if (response === "tool") {
          message.stopReason = "toolUse";
          message.content = [{ type: "toolCall", id: "already-completed", name: "once", arguments: {} }];
        } else if (response === "success") {
          message.content = [{ type: "text", text: "Success" }];
        } else {
          message.stopReason = response === "aborted" ? "aborted" : "error";
          message.errorMessage = response === "failure" ? error : response === "aborted" ? "Operation aborted"
            : typeof response === "object" ? response.errorMessage : response;
          if (typeof response === "object") message.content = response.content;
        }
        stream.push({ type: "start", partial: message });
        stream.push(message.stopReason === "error" || message.stopReason === "aborted"
          ? { type: "error", reason: message.stopReason, error: message }
          : { type: "done", reason: message.stopReason, message });
      });
      return stream;
    },
  });
  const configPath = join(dir, "retry-rules.json");
  if (!useDefaultConfig) await writeFile(configPath, typeof config === "string" ? config : JSON.stringify(config));
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
    additionalExtensionPaths: [extensionPath],
    extensionFactories: [(pi) => pi.on("before_provider_request", (event) => {
      hookedPayloads.push(structuredClone(event.payload));
    })],
  });
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (useDefaultConfig) process.env.PI_CODING_AGENT_DIR = dir;
  try { await loader.reload(); } finally {
    if (useDefaultConfig) {
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  }
  assert.deepEqual(loader.getExtensions().errors, []);
  if (!useDefaultConfig) loader.getExtensions().runtime.flagValues.set("retry-rules-config", configPath);
  const created = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime,
    model: runtime.getModel("test-provider", "test-model"), thinkingLevel: "off", resourceLoader: loader,
    settingsManager, sessionManager: sessionManager ?? (persistent ? SessionManager.create(dir, join(dir, "sessions")) : SessionManager.inMemory(dir)), tools: ["once"],
    customTools: [{ name: "once", label: "Once", description: "Count one completed execution",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => { toolRuns++; return { content: [{ type: "text", text: "tool-result-kept" }], details: {} }; } }],
  });
  const session = created.session;
  t.after(async () => { session.dispose(); await rm(dir, { recursive: true, force: true }); });
  const events = [];
  const errors = [];
  session.subscribe((event) => events.push(event));
  await session.bindExtensions({ mode: uiContext ? "rpc" : "json", uiContext, onError: (event) => errors.push(event),
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      reload: async () => {
        if (fileSettings) await settingsManager.reload();
        await session.reload({ beforeSessionStart: () => {
          if (!useDefaultConfig) loader.getExtensions().runtime.flagValues.set("retry-rules-config", configPath);
        } });
      },
    } });
  return { session, dir, loader, requests, payloads, hookedPayloads, settingsManager, events, errors, toolRuns: () => toolRuns };
}

test("real Pi retry excludes failed reply, keeps raw history and never replays completed tool", async (t) => {
  const h = await setup(t, { responses: ["tool", "failure", "success"] });
  await h.session.prompt("Run the tool and finish");
  assert.equal(h.requests.length, 3);
  assert.equal(h.toolRuns(), 1);
  assert.equal(h.events.filter((e) => e.type === "auto_retry_start").length, 1);
  assert.deepEqual(h.errors, []);
  const next = h.requests.at(-1);
  assert.ok(next.some((m) => m.role === "toolResult" && m.content.some((c) => c.text === "tool-result-kept")));
  assert.equal(next.filter((m) => m.role === "user").length, 1);
  assert.ok(!next.some((m) => m.errorMessage || JSON.stringify(m).includes(RETRY_HINT)));
  const entries = h.session.sessionManager.getEntries();
  const failed = entries.find((e) => e.type === "message" && e.message.stopReason === "error");
  assert.equal(failed.message.errorMessage, error + RETRY_HINT);
  assert.ok(entries.some((e) => e.type === "context_edit" && e.targetId === failed.id && e.replacement === null));
});

test("maxRetries is native and exhaustion leaves a final visible error", async (t) => {
  const h = await setup(t, { responses: ["failure"] });
  await h.session.prompt("Test");
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.events.filter((e) => e.type === "auto_retry_start").map((e) => e.delayMs), [1, 2]);
  assert.equal(h.events.find((e) => e.type === "auto_retry_end").success, false);
  assert.equal(h.session.messages.filter((m) => m.stopReason === "error").length, 1);
});

test("unmatched failures and aborted responses stop without retries", async (t) => {
  for (const response of ["invalid_request_error: invalid schema", "aborted", "error: insufficient_quota"]) {
    const h = await setup(t, { responses: [response] });
    await h.session.prompt("Test");
    assert.equal(h.requests.length, 1);
    assert.ok(!h.events.some((e) => e.type === "auto_retry_start"));
  }
});

test("native retry disabled remains disabled", async (t) => {
  const h = await setup(t, { retry: { enabled: false } });
  await h.session.prompt("Test");
  assert.equal(h.requests.length, 1);
  assert.equal(h.session.messages.at(-1).errorMessage, error);
});

test("cancel during native backoff prevents another request", async (t) => {
  const h = await setup(t, { retry: { baseDelayMs: 60000, maxAgentDelayMs: 60000 } });
  const retryStarted = new Promise((resolve) => h.session.subscribe((e) => {
    if (e.type === "auto_retry_start") resolve();
  }));
  const running = h.session.prompt("Test");
  await retryStarted;
  await h.session.abort();
  await running;
  assert.equal(h.requests.length, 1);
  assert.equal(h.session.isRetrying, false);
});

test("custom config disables rules and invalid config fails closed", async (t) => {
  for (const config of [{ enabled: false, rules: [] }, "{invalid-json", { enabled: true, rules: [{}] }]) {
    const h = await setup(t, { config });
    await h.session.prompt("Test");
    assert.equal(h.requests.length, 1);
    assert.equal(h.session.messages.at(-1).errorMessage, error);
    assert.deepEqual(h.errors, []);
  }
});

test("reload reads the selected config and does not stack message hooks", async (t) => {
  const config = { enabled: true, rules: [{ provider: "test-provider", contains: ["custom gateway refusal"] }] };
  const h = await setup(t, { responses: ["custom gateway refusal", "success", "custom gateway refusal"], config });
  for (let i = 0; i < 2; i++) {
    await h.session.reload({ beforeSessionStart: () => {
      h.loader.getExtensions().runtime.flagValues.set("retry-rules-config", join(h.dir, "retry-rules.json"));
    } });
  }
  await h.session.prompt("Test");
  assert.equal(h.requests.length, 2);
  const failed = h.session.sessionManager.getEntries().find((e) => e.type === "message" && e.message.stopReason === "error");
  assert.equal(failed.message.errorMessage, "custom gateway refusal" + RETRY_HINT);
  assert.deepEqual(h.errors, []);

  await writeFile(join(h.dir, "retry-rules.json"), JSON.stringify({ enabled: false, rules: [] }));
  await h.session.reload({ beforeSessionStart: () => {
    h.loader.getExtensions().runtime.flagValues.set("retry-rules-config", join(h.dir, "retry-rules.json"));
  } });
  await h.session.prompt("Another request");
  assert.equal(h.requests.length, 3);
  assert.equal(h.session.messages.at(-1).errorMessage, "custom gateway refusal");
  assert.equal(h.events.filter((e) => e.type === "auto_retry_start").length, 1);
  await writeFile(join(h.dir, "retry-rules.json"), "{invalid-json");
  await h.session.reload({ beforeSessionStart: () => {
    h.loader.getExtensions().runtime.flagValues.set("retry-rules-config", join(h.dir, "retry-rules.json"));
  } });
  await h.session.prompt("Request with invalid config");
  assert.equal(h.requests.length, 4);
  assert.equal(h.session.messages.at(-1).errorMessage, "custom gateway refusal");
  assert.equal(h.events.filter((e) => e.type === "auto_retry_start").length, 1);
});

test("broad rules still cannot override authentication, quota or overflow handling", async (t) => {
  const config = { enabled: true, rules: [{ provider: "test-provider", contains: ["error"] }] };
  for (const response of ["error: HTTP 401", "error: HTTP 403", "error: authentication_error", "error: insufficient_quota", "error: context_length_exceeded"]) {
    const h = await setup(t, { responses: [response], config });
    await h.session.prompt("Test");
    assert.equal(h.requests.length, 1);
    assert.equal(h.session.messages.at(-1).errorMessage, response);
    assert.ok(!h.events.some((e) => e.type === "auto_retry_start"));
  }
});

test("missing config stays disabled without creating a replacement file", async (t) => {
  const h = await setup(t);
  const missing = join(h.dir, "missing-rules.json");
  await h.session.reload({ beforeSessionStart: () => {
    h.loader.getExtensions().runtime.flagValues.set("retry-rules-config", missing);
  } });
  await h.session.prompt("Test");
  assert.equal(h.requests.length, 1);
  assert.equal(h.session.messages.at(-1).errorMessage, error);
  await assert.rejects(() => readFile(missing), { code: "ENOENT" });
});

test("persisted context omission survives opening the session in a fresh runtime", async (t) => {
  const h = await setup(t, { responses: ["tool", "failure", "success"], persistent: true });
  await h.session.prompt("Run tool then finish");
  const sessionFile = h.session.sessionManager.getSessionFile();
  assert.ok(sessionFile);
  h.session.dispose();
  const reopened = SessionManager.open(sessionFile);
  const resumed = await setup(t, { responses: ["success"], sessionManager: reopened });
  await resumed.session.prompt("Continue");
  assert.ok(!resumed.requests[0].some((m) => m.errorMessage || JSON.stringify(m).includes(RETRY_HINT)));
  assert.ok(resumed.requests[0].some((m) => m.role === "toolResult" && m.toolCallId === "already-completed"));
  assert.equal(resumed.toolRuns(), 0);
  assert.deepEqual(resumed.errors, []);
});

function dialogs({ selections = [], edits = [], confirmations = [] } = {}) {
  const notifications = [];
  const prefills = [];
  const statuses = [];
  return { notifications, prefills, statuses,
    setStatus: (key, text) => statuses.push({ key, text }),
    notify: (text, level) => notifications.push({ text, level }),
    select: async (_title, options) => {
      const choice = selections.shift();
      return typeof choice === "number" ? options[choice] : choice;
    },
    editor: async (title, prefill) => { prefills.push({ title, prefill }); return edits.shift(); },
    confirm: async () => confirmations.shift() ?? false,
  };
}

async function manualRetry(h) {
  await h.session.prompt("/retry");
  await h.session.waitForIdle();
  assert.deepEqual(h.errors, []);
}

const disabled = parseConfig(DEFAULT_CONFIG);
const opaqueFailure = "invalid_request_error: temporary gateway refusal";
const manualType = "pi-retry-rules:manual-retry";

test("manual retry works without auto rules, persists omissions and retains completed tools", async (t) => {
  const h = await setup(t, { responses: ["tool", opaqueFailure, "success"], config: disabled });
  await h.session.prompt("Run the tool and finish");
  assert.equal(h.requests.length, 2);
  await manualRetry(h);
  assert.equal(h.requests.length, 3);
  assert.equal(h.toolRuns(), 1);
  const next = h.requests.at(-1);
  assert.equal(next.filter((m) => m.role === "user").length, 1);
  assert.ok(next.some((m) => m.role === "toolResult" && m.toolCallId === "already-completed"));
  assert.ok(!next.some((m) => m.errorMessage || m.customType === manualType || JSON.stringify(m).includes(opaqueFailure)));
  const entries = h.session.sessionManager.getBranch();
  const failed = entries.find((e) => e.type === "message" && e.message.stopReason === "error");
  const marker = entries.find((e) => e.type === "custom_message" && e.customType === manualType);
  assert.equal(failed.message.errorMessage, opaqueFailure);
  for (const targetId of [failed.id, marker.id]) {
    assert.ok(entries.some((e) => e.type === "context_edit" && e.targetId === targetId && e.replacement === null));
  }
  assert.ok(!h.events.some((e) => e.type === "auto_retry_start"));
  await manualRetry(h);
  assert.equal(h.requests.length, 3, "success cannot be manually retried");
});

test("manual retry requests once, then native retries still use existing rules and budget", async (t) => {
  const h = await setup(t, { responses: [opaqueFailure, "failure", "success"] });
  await h.session.prompt("Test");
  await manualRetry(h);
  assert.equal(h.requests.length, 3);
  assert.equal(h.events.filter((e) => e.type === "auto_retry_start").length, 1);
  assert.equal(h.requests.at(-1).filter((m) => m.role === "user").length, 1);
  assert.ok(!h.requests.at(-1).some((m) => m.errorMessage || m.customType === manualType));
});

test("manual retry can be repeated after failure and respects auto-retry disabled", async (t) => {
  const h = await setup(t, { responses: [opaqueFailure, opaqueFailure, "success"], retry: { enabled: false } });
  await h.session.prompt("Test");
  await manualRetry(h);
  assert.equal(h.requests.length, 2);
  assert.equal(h.session.messages.at(-1).stopReason, "error");
  await manualRetry(h);
  assert.equal(h.requests.length, 3);
  assert.ok(!h.events.some((e) => e.type === "auto_retry_start"));
});

test("manual retry rejects successful, aborted, new and user-ending conversations", async (t) => {
  for (const response of ["success", "aborted"]) {
    const h = await setup(t, { responses: [response], config: disabled });
    await manualRetry(h);
    assert.equal(h.requests.length, 0);
    await h.session.prompt("Test");
    await manualRetry(h);
    assert.equal(h.requests.length, 1);
  }
  const h = await setup(t, { responses: [opaqueFailure], config: disabled });
  await h.session.prompt("Test");
  h.session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "New request" }], timestamp: Date.now() });
  await manualRetry(h);
  assert.equal(h.requests.length, 1);
});

test("manual retry refuses busy sessions and duplicate submissions, and is cancellable", async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let started;
  const retryStarted = new Promise((resolve) => { started = resolve; });
  const h = await setup(t, { responses: [opaqueFailure, "success"], config: disabled,
    providerGate: async (attempt) => { if (attempt === 2) { started(); await blocked; } } });
  await h.session.prompt("Test");
  await h.session.prompt("/retry");
  await retryStarted;
  await h.session.prompt("/retry");
  assert.equal(h.requests.length, 2);
  release();
  await h.session.waitForIdle();
  assert.deepEqual(h.errors, []);

  const cancelling = await setup(t, { responses: [opaqueFailure, "failure"],
    retry: { baseDelayMs: 60000, maxAgentDelayMs: 60000 } });
  await cancelling.session.prompt("Test");
  const backoff = new Promise((resolve) => cancelling.session.subscribe((e) => {
    if (e.type === "auto_retry_start") resolve();
  }));
  await cancelling.session.prompt("/retry");
  await backoff;
  await cancelling.session.abort();
  await cancelling.session.waitForIdle();
  assert.equal(cancelling.requests.length, 2);
  assert.equal(cancelling.session.isIdle, true);
  assert.deepEqual(cancelling.errors, []);
});

test("manual context edits survive reopening even without loading the extension", async (t) => {
  const h = await setup(t, { responses: ["tool", opaqueFailure, "success"], config: disabled, persistent: true });
  await h.session.prompt("Run tool then finish");
  await manualRetry(h);
  const sessionFile = h.session.sessionManager.getSessionFile();
  h.session.dispose();
  const reopened = SessionManager.open(sessionFile);
  const projection = reopened.buildSessionProjection();
  assert.ok(!projection.messages.some((m) => m.errorMessage || m.customType === manualType));
  assert.ok(projection.messages.some((m) => m.role === "toolResult" && m.toolCallId === "already-completed"));
  const resumed = await setup(t, { responses: ["success"], sessionManager: reopened, config: disabled });
  await resumed.session.prompt("Continue");
  assert.ok(!resumed.requests[0].some((m) => m.errorMessage || m.customType === manualType));
  assert.equal(resumed.toolRuns(), 0);
});

test("settings menu toggles rules and changes retry immediately without reload", async (t) => {
  const config = { enabled: false, rules: [{ provider: "test-provider", contains: [opaqueFailure] }] };
  const ui = dialogs({ selections: ["Enable automatic rules", "Exit"] });
  const h = await setup(t, { responses: [opaqueFailure, "success"], config, uiContext: ui });
  await h.session.prompt("/retry-rules");
  assert.equal(JSON.parse(await readFile(join(h.dir, "retry-rules.json"), "utf8")).enabled, true);
  await h.session.prompt("Test");
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.errors, []);
});

test("settings menu creates, edits and deletes rules with persisted prefilled fields", async (t) => {
  const ui = dialogs({ selections: ["Add rule", "Exit", "Edit rule", 0, "Exit", "Delete rule", 0, "Exit"],
    edits: ["test-provider", "", opaqueFailure, "test-provider", "test-model", "first\nsecond"], confirmations: [true] });
  const h = await setup(t, { config: { enabled: true, rules: [] }, uiContext: ui });
  const path = join(h.dir, "retry-rules.json");
  await h.session.prompt("/retry-rules");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: true, language: "en",
    rules: [{ provider: "test-provider", contains: [opaqueFailure] }] });
  assert.equal(ui.prefills[0].prefill, "test-provider");
  assert.equal(ui.prefills[1].prefill, "test-model");
  await h.session.prompt("/retry-rules");
  assert.equal(ui.prefills[4].prefill, "");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: true, language: "en",
    rules: [{ provider: "test-provider", model: "test-model", contains: ["first", "second"] }] });
  await h.session.prompt("/retry-rules");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: true, language: "en", rules: [] });
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.errors, []);
});

test("cancelled, invalid and unconfirmed rule changes leave disk and context untouched", async (t) => {
  const ui = dialogs({ selections: ["Add rule", "Add rule", "Delete rule", 0, "Exit"],
    edits: [undefined, "", "", "some error"], confirmations: [false] });
  const config = { enabled: true, rules: [{ provider: "test-provider", contains: [opaqueFailure] }] };
  const h = await setup(t, { config, uiContext: ui });
  const path = join(h.dir, "retry-rules.json");
  const before = await readFile(path, "utf8");
  const entries = h.session.sessionManager.getEntries().length;
  await h.session.prompt("/retry-rules");
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(h.session.sessionManager.getEntries().length, entries);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.errors, []);
});

test("settings refuse invalid files and external changes, reload picks up external configuration", async (t) => {
  const ui = dialogs({ selections: ["Enable automatic rules", "Exit", "Reload configuration", "Enable automatic rules", "Exit"] });
  const h = await setup(t, { config: "{invalid-json", uiContext: ui });
  const path = join(h.dir, "retry-rules.json");
  await h.session.prompt("/retry-rules");
  assert.equal(await readFile(path, "utf8"), "{invalid-json");
  await writeFile(path, JSON.stringify(disabled));
  await h.session.prompt("/retry-rules");
  assert.equal(JSON.parse(await readFile(path, "utf8")).enabled, true);
  await writeFile(path, JSON.stringify(disabled));
  // Exit after the rejected save rather than looping the test dialog forever.
  let selection = 0;
  ui.select = async () => selection++ === 0 ? "Disable automatic rules" : "Exit";
  await h.session.prompt("/retry-rules");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), disabled);
  assert.ok(ui.notifications.some((n) => n.text.includes("changed in another session")));
  assert.deepEqual(h.errors, []);
});

test("settings save failure leaves current rules intact and cleans temporary files", async (t) => {
  const ui = dialogs({ selections: ["Enable automatic rules", "Exit"] });
  const h = await setup(t, { config: disabled, responses: [opaqueFailure], uiContext: ui });
  await rm(join(h.dir, "retry-rules.json"));
  await h.session.prompt("/retry-rules");
  await h.session.prompt("Test");
  assert.equal(h.requests.length, 1);
  assert.ok(ui.notifications.some((n) => n.level === "error" && n.text.includes("Cannot save")));
  assert.ok(!(await readdir(h.dir)).some((name) => name.endsWith(".tmp")));
  assert.deepEqual(h.errors, []);
});

test("manual retry permits explicit retries of fatal errors without changing automatic policy", async (t) => {
  for (const response of ["HTTP 401", "insufficient_quota", "context_length_exceeded"]) {
    const h = await setup(t, { responses: [response, "success"], config: disabled });
    await h.session.prompt("Test");
    await manualRetry(h);
    assert.equal(h.requests.length, 2);
    assert.ok(!h.requests.at(-1).some((m) => m.errorMessage));
    assert.deepEqual(JSON.parse(await readFile(join(h.dir, "retry-rules.json"), "utf8")), disabled);
  }
});

test("manual retry after exhausting automatic retries does not replay old failures", async (t) => {
  const h = await setup(t, { responses: ["failure", "failure", "failure", "success"] });
  await h.session.prompt("Test");
  assert.equal(h.requests.length, 3);
  await manualRetry(h);
  assert.equal(h.requests.length, 4);
  assert.ok(!h.requests.at(-1).some((m) => m.errorMessage));
});

test("aborted manual attempt persists omissions but cancellation cannot be manually retried", async (t) => {
  const h = await setup(t, { responses: [opaqueFailure, "aborted"], config: disabled });
  await h.session.prompt("Test");
  await manualRetry(h);
  const messages = h.session.sessionManager.buildSessionProjection().messages;
  assert.ok(!messages.some((m) => m.errorMessage === opaqueFailure || m.customType === manualType));
  assert.equal(messages.at(-1).stopReason, "aborted");
  await manualRetry(h);
  assert.equal(h.requests.length, 2);
});

test("reloading after manual retry does not restore errors or duplicate control messages", async (t) => {
  const h = await setup(t, { responses: [opaqueFailure, "success", "success"], config: disabled });
  await h.session.prompt("Test");
  await manualRetry(h);
  await h.session.reload({ beforeSessionStart: () => {
    h.loader.getExtensions().runtime.flagValues.set("retry-rules-config", join(h.dir, "retry-rules.json"));
  } });
  await h.session.prompt("Next request");
  assert.ok(!h.requests.at(-1).some((m) => m.errorMessage || m.customType === manualType));
  const markers = h.session.sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === manualType);
  assert.equal(markers.length, 1);
  assert.deepEqual(h.errors, []);
});

test("settings reload restores saved values and keeps one command registration", async (t) => {
  const ui = dialogs({ selections: ["Enable automatic rules", "Exit"] });
  const h = await setup(t, { config: disabled, uiContext: ui, responses: ["success"] });
  await h.session.prompt("/retry-rules");
  await h.session.reload({ beforeSessionStart: () => {
    h.loader.getExtensions().runtime.flagValues.set("retry-rules-config", join(h.dir, "retry-rules.json"));
  } });
  let titles = [];
  ui.select = async (title) => { titles.push(title); return "Exit"; };
  await h.session.prompt("/retry-rules");
  assert.equal(titles.length, 1);
  assert.ok(titles[0].includes("on"));
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.errors, []);
});

test("manual retry refusal during native backoff does not queue another run", async (t) => {
  const h = await setup(t, { responses: ["failure"], retry: { baseDelayMs: 60000, maxAgentDelayMs: 60000 } });
  const backoff = new Promise((resolve) => h.session.subscribe((e) => {
    if (e.type === "auto_retry_start") resolve();
  }));
  const running = h.session.prompt("Test");
  await backoff;
  await h.session.prompt("/retry");
  await h.session.abort();
  await running;
  assert.equal(h.requests.length, 1);
  assert.ok(!h.session.sessionManager.getBranch().some((e) => e.type === "custom_message" && e.customType === manualType));
  assert.deepEqual(h.errors, []);
});

test("manual retry excludes partial text and unexecuted tool calls in a failed reply", async (t) => {
  const h = await setup(t, { responses: ["tool", { errorMessage: opaqueFailure, content: [
    { type: "text", text: "partial-failed-reply-not-for-replay" },
    { type: "toolCall", id: "never-executed", name: "once", arguments: {} },
  ] }, "success"], config: disabled });
  await h.session.prompt("Run the tool and finish");
  assert.equal(h.toolRuns(), 1);
  await manualRetry(h);
  assert.equal(h.toolRuns(), 1);
  assert.ok(!JSON.stringify(h.requests.at(-1)).includes("partial-failed-reply-not-for-replay"));
  assert.ok(!JSON.stringify(h.requests.at(-1)).includes("never-executed"));
  const rawError = h.session.sessionManager.getBranch().find((e) => e.type === "message" && e.message.stopReason === "error");
  assert.equal(rawError.message.content.length, 2);
});

test("settings lock rejects simultaneous writes and cleans up after saving", async (t) => {
  const ui = dialogs({ selections: ["Enable automatic rules", "Exit", "Enable automatic rules", "Exit"] });
  const h = await setup(t, { config: disabled, uiContext: ui });
  const path = join(h.dir, "retry-rules.json");
  await writeFile(path + ".lock", "another writer", { flag: "wx" });
  await h.session.prompt("/retry-rules");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), disabled);
  assert.equal(await readFile(path + ".lock", "utf8"), "another writer");
  assert.ok(ui.notifications.some((n) => n.text.includes("Another session is saving")));
  await rm(path + ".lock");
  await h.session.prompt("/retry-rules");
  assert.equal(JSON.parse(await readFile(path, "utf8")).enabled, true);
  assert.ok(!(await readdir(h.dir)).some((name) => name.endsWith(".lock") || name.endsWith(".tmp")));
  assert.deepEqual(h.errors, []);
});

test("two independent sessions saving concurrently cannot overwrite each other's configuration", async (t) => {
  const firstUi = dialogs({ selections: ["Add rule", "Exit"], edits: ["test-provider", "first-model", "first-error"] });
  const secondUi = dialogs({ selections: ["Add rule", "Exit"], edits: ["test-provider", "second-model", "second-error"] });
  const first = await setup(t, { config: disabled, uiContext: firstUi });
  const second = await setup(t, { config: disabled, uiContext: secondUi });
  const path = join(first.dir, "retry-rules.json");
  await second.session.reload({ beforeSessionStart: () => {
    second.loader.getExtensions().runtime.flagValues.set("retry-rules-config", path);
  } });
  await Promise.all([first.session.prompt("/retry-rules"), second.session.prompt("/retry-rules")]);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.rules.length, 1);
  const notices = [...firstUi.notifications, ...secondUi.notifications];
  assert.equal(notices.filter((n) => n.text === "Retry rules saved and applied immediately.").length, 1);
  assert.ok(notices.some((n) => n.text.includes("Another session is saving") || n.text.includes("changed in another session")));
  assert.ok(["first-model", "second-model"].includes(saved.rules[0].model));
  assert.ok([...first.errors, ...second.errors].length === 0);
  assert.ok(!(await readdir(first.dir)).some((name) => name.endsWith(".lock") || name.endsWith(".tmp")));
});

test("real provider serialization sends identical payload for automatic and manual error retry", async (t) => {
  for (const manual of [false, true]) {
    const h = await setup(t, { serializedProvider: true, responses: ["tool", "failure", "success"], config: manual ? disabled
      : { enabled: true, rules: [{ provider: "test-provider", contains: ["temporary upstream rejection", "invalid_request_error"] }] } });
    await h.session.prompt("Run the tool and finish");
    if (manual) await manualRetry(h);
    assert.equal(h.payloads.length, 3);
    assert.equal(h.toolRuns(), 1);
    assert.deepEqual(h.payloads[2], h.payloads[1], `payload is unchanged for ${manual ? "manual" : "automatic"} retry`);
    assert.deepEqual(JSON.parse(JSON.stringify(h.hookedPayloads)), h.payloads);
    assert.ok(!JSON.stringify(h.payloads[2]).includes("invalid_request_error"));
    assert.ok(!JSON.stringify(h.payloads[2]).includes(manualType));
    assert.deepEqual(h.errors, []);
  }
});

test("partial stream failure is absent from the real serialized manual retry payload", async (t) => {
  const h = await setup(t, { serializedProvider: true, responses: ["partial", "success"], config: disabled });
  await h.session.prompt("Test");
  assert.equal(h.session.messages.at(-1).stopReason, "error");
  assert.ok(JSON.stringify(h.session.messages.at(-1)).includes("partial-not-for-replay"));
  await manualRetry(h);
  assert.equal(h.payloads.length, 2);
  assert.deepEqual(h.payloads[0], h.payloads[1]);
  assert.ok(!JSON.stringify(h.payloads[1]).includes("partial-not-for-replay"));
});

test("complete JSON editor modifies all rule fields and validates before saving", async (t) => {
  const next = { enabled: true, language: "en", rules: [{ provider: "test-provider", model: "test-model", contains: [opaqueFailure] }] };
  const ui = dialogs({ selections: ["Edit full configuration JSON", "Exit", "Edit full configuration JSON", "Exit", "View configuration", "Exit"],
    edits: [JSON.stringify(next), "{invalid-json"] });
  const h = await setup(t, { config: disabled, uiContext: ui, responses: [opaqueFailure, "success"] });
  const path = join(h.dir, "retry-rules.json");
  await h.session.prompt("/retry-rules");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), next);
  await h.session.prompt("/retry-rules");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), next);
  await h.session.prompt("/retry-rules");
  assert.ok(ui.notifications.some((n) => n.text.includes(path) && n.text.includes("Pi native settings:")));
  await h.session.prompt("Test");
  assert.equal(h.requests.length, 2);
});

test("config path can be created, edited and restored entirely through the command", async (t) => {
  const ui = dialogs();
  const h = await setup(t, { config: disabled, uiContext: ui, persistent: true });
  await h.session.prompt("Initialize persistent session");
  const path = join(h.dir, "custom", "rules.json");
  const next = { enabled: true, language: "en", rules: [{ provider: "test-provider", contains: [opaqueFailure] }] };
  let step = 0;
  const choices = ["Configuration path", "Edit full configuration JSON", "Exit"];
  const edits = [path, JSON.stringify(next)];
  ui.select = async () => choices[step++];
  ui.editor = async () => edits.shift();
  ui.confirm = async () => true;
  await h.session.prompt("/retry-rules");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), next);
  assert.deepEqual(JSON.parse(await readFile(join(h.dir, "retry-rules.json"), "utf8")), disabled);
  await h.session.reload();
  ui.select = async () => step++ === 3 ? "View configuration" : "Exit";
  await h.session.prompt("/retry-rules");
  assert.ok(ui.notifications.some((n) => n.text.startsWith(`Configuration path: ${path}`)));
  const file = h.session.sessionManager.getSessionFile();
  h.session.dispose();
  const resumedUi = dialogs({ selections: ["View configuration", "Exit"] });
  const resumed = await setup(t, { config: disabled, uiContext: resumedUi, sessionManager: SessionManager.open(file) });
  await resumed.session.prompt("/retry-rules");
  assert.ok(resumedUi.notifications.some((n) => n.text.startsWith(`Configuration path: ${path}`)));
});

const nativeRetry = { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 5,
  provider: { maxRetries: 0, maxRetryDelayMs: 60000, timeoutMs: 10000 } };

test("native parameters save to trusted project, preserve settings and take effect via reload", async (t) => {
  const ui = dialogs({ selections: ["Pi native retry settings", "Current project"], edits: [JSON.stringify(nativeRetry)], confirmations: [true] });
  const h = await setup(t, { fileSettings: true, uiContext: ui, config: { enabled: true,
    rules: [{ provider: "test-provider", contains: [opaqueFailure] }] }, responses: [opaqueFailure] });
  const path = join(h.dir, ".pi", "settings.json");
  await mkdir(join(h.dir, ".pi"));
  await writeFile(path, JSON.stringify({ customUserSetting: "kept", retry: { provider: { customOption: "kept" } } }));
  await h.session.prompt("/retry-rules");
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.customUserSetting, "kept");
  assert.equal(saved.retry.provider.customOption, "kept");
  assert.equal(h.settingsManager.getRetrySettings().maxRetries, 1);
  assert.equal(h.settingsManager.getProviderRetrySettings().timeoutMs, 10000);
  assert.equal(h.requests.length, 0);
  await h.session.prompt("Test");
  assert.equal(h.requests.length, 2);
  assert.equal(h.events.filter((e) => e.type === "auto_retry_start").length, 1);
  assert.deepEqual(h.errors, []);
});

test("native retry settings reject invalid inputs, untrusted writes and cancellation", async (t) => {
  for (const opts of [
    { projectTrusted: true, input: '{"enabled":true}', confirm: true },
    { projectTrusted: false, input: JSON.stringify(nativeRetry), confirm: true },
    { projectTrusted: true, input: JSON.stringify(nativeRetry), confirm: false },
  ]) {
    const ui = dialogs({ selections: ["Pi native retry settings", "Current project", "Exit"], edits: [opts.input], confirmations: [opts.confirm] });
    // Invalid JSON returns before selecting a scope; the leftover choice is safely ignored.
    if (opts.input.startsWith('{"enabled":true}')) ui.select = async (_title, choices) => choices.includes("Pi native retry settings")
      ? (ui.opened ? "Exit" : (ui.opened = true, "Pi native retry settings")) : "Current project";
    const h = await setup(t, { uiContext: ui, fileSettings: true, config: disabled, projectTrusted: opts.projectTrusted });
    await h.session.prompt("/retry-rules");
    await assert.rejects(readFile(join(h.dir, ".pi", "settings.json")), { code: "ENOENT" });
    assert.equal(h.settingsManager.getRetrySettings().maxRetries, 2);
    assert.deepEqual(h.errors, []);
  }
});

test("native editor defaults can be saved unchanged and removing timeout clears the saved value", async (t) => {
  const ui = dialogs({ selections: ["Pi native retry settings", "Current project"] , confirmations: [true] });
  let initial;
  ui.editor = async (_title, prefill) => { initial = JSON.parse(prefill); return prefill; };
  const h = await setup(t, { fileSettings: true, uiContext: ui, config: disabled });
  await h.session.prompt("/retry-rules");
  assert.equal(initial.provider.maxRetries, 0);
  const path = join(h.dir, ".pi/settings.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  saved.retry.provider.timeoutMs = 1234;
  await writeFile(path, JSON.stringify(saved));
  let selection = 0;
  ui.select = async () => ["Pi native retry settings", "Current project"][selection++];
  ui.editor = async (_title, prefill) => {
    const next = JSON.parse(prefill);
    delete next.provider.timeoutMs;
    return JSON.stringify(next);
  };
  ui.confirm = async () => true;
  await h.session.prompt("/retry-rules");
  assert.ok(!("timeoutMs" in JSON.parse(await readFile(path, "utf8")).retry.provider));
  assert.deepEqual(h.errors, []);
});

test("complete JSON editor repairs invalid configuration only after explicit confirmation", async (t) => {
  const ui = dialogs({ selections: ["Edit full configuration JSON", "Exit", "Edit full configuration JSON", "Exit"],
    edits: [JSON.stringify(disabled), JSON.stringify(disabled)], confirmations: [false, true] });
  const h = await setup(t, { config: "{broken", uiContext: ui });
  const path = join(h.dir, "retry-rules.json");
  await h.session.prompt("/retry-rules");
  assert.equal(await readFile(path, "utf8"), "{broken");
  await h.session.prompt("/retry-rules");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), disabled);
  assert.deepEqual(h.errors, []);
});

test("personal native parameters update only the selected settings scope", async (t) => {
  const ui = dialogs({ selections: ["Pi native retry settings", "User settings"], edits: [JSON.stringify(nativeRetry)], confirmations: [true] });
  const h = await setup(t, { config: disabled, fileSettings: true, uiContext: ui });
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = h.dir;
  try {
    await h.session.prompt("/retry-rules");
    const saved = JSON.parse(await readFile(join(h.dir, "settings.json"), "utf8"));
    assert.equal(saved.cacheWarming, "off");
    assert.deepEqual(saved.retry, nativeRetry);
    assert.equal(h.settingsManager.getRetrySettings().maxRetries, 1);
    await assert.rejects(readFile(join(h.dir, ".pi/settings.json")), { code: "ENOENT" });
    assert.deepEqual(h.errors, []);
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
  }
});

test("native settings editor cannot overwrite invalid settings or an active writer lock", async (t) => {
  for (const invalid of [true, false]) {
    const ui = dialogs({ selections: ["Pi native retry settings", "Current project", "Exit"], edits: [JSON.stringify(nativeRetry)], confirmations: [true] });
    const h = await setup(t, { fileSettings: true, config: disabled, uiContext: ui });
    const path = join(h.dir, ".pi/settings.json");
    await mkdir(join(h.dir, ".pi"));
    if (invalid) await writeFile(path, "{broken");
    else { await writeFile(path, "{}"); await mkdir(path + ".lock"); }
    await h.session.prompt("/retry-rules");
    assert.equal(await readFile(path, "utf8"), invalid ? "{broken" : "{}");
    assert.equal(h.settingsManager.getRetrySettings().maxRetries, 2);
    assert.deepEqual(h.errors, []);
    if (!invalid) assert.ok((await readdir(join(h.dir, ".pi"))).includes("settings.json.lock"));
  }
});

test("missing configuration can be created by complete JSON editing without touching default rules", async (t) => {
  const ui = dialogs({ selections: ["Edit full configuration JSON", "Exit"], edits: [JSON.stringify(disabled)], confirmations: [true] });
  const h = await setup(t, { config: disabled, uiContext: ui });
  const missing = join(h.dir, "new", "retry-rules.json");
  await h.session.reload({ beforeSessionStart: () => h.loader.getExtensions().runtime.flagValues.set("retry-rules-config", missing) });
  await h.session.prompt("/retry-rules");
  assert.deepEqual(JSON.parse(await readFile(missing, "utf8")), disabled);
  assert.deepEqual(h.errors, []);
});

test("switching session tree branches restores that branch's selected config path", async (t) => {
  const ui = dialogs();
  const h = await setup(t, { config: disabled, uiContext: ui });
  await h.session.prompt("Initialize");
  const originalLeaf = h.session.sessionManager.getLeafId();
  const custom = join(h.dir, "other-rules.json");
  await writeFile(custom, JSON.stringify({ enabled: true, rules: [] }));
  let choice = 0;
  ui.select = async () => ["Configuration path", "Exit"][choice++];
  ui.editor = async () => custom;
  await h.session.prompt("/retry-rules");
  await h.session.navigateTree(originalLeaf);
  choice = 0;
  ui.select = async () => ["View configuration", "Exit"][choice++];
  await h.session.prompt("/retry-rules");
  assert.deepEqual(h.errors, []);
});

test("default config stays outside the package and is created only on a user save", async (t) => {
  const ui = dialogs({ selections: ["Language", "简体中文", "退出"] });
  const h = await setup(t, { uiContext: ui, useDefaultConfig: true, responses: ["failure"] });
  const path = join(h.dir, "pi-retry-rules.json");
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await h.session.prompt("Test");
  assert.equal(h.requests.length, 1, "no default automatic error retry");
  await h.session.prompt("/retry-rules");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: false, language: "zh-CN", rules: [] });
  assert.ok(ui.notifications.some((n) => n.text === "重试规则已保存并立即生效。"));
  assert.deepEqual(h.errors, []);
});

test("language menu switches immediately and persists across reload", async (t) => {
  const ui = dialogs({ selections: ["Language", "简体中文", "新增规则", "退出"],
    edits: ["test-provider", "test-model", "temporary error"] });
  const h = await setup(t, { config: disabled, uiContext: ui });
  await h.session.prompt("/retry-rules");
  const path = join(h.dir, "retry-rules.json");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: false, language: "zh-CN",
    rules: [{ provider: "test-provider", model: "test-model", contains: ["temporary error"] }] });
  assert.ok(ui.prefills[0].title.includes("供应商"));
  await h.session.reload({ beforeSessionStart: () => h.loader.getExtensions().runtime.flagValues.set("retry-rules-config", path) });
  let step = 0;
  ui.select = async (_title, options) => {
    if (step++ === 0) { assert.ok(options.includes("语言")); return "语言"; }
    if (step === 2) return "English";
    assert.ok(options.includes("Exit"));
    return "Exit";
  };
  await h.session.prompt("/retry-rules");
  assert.equal(JSON.parse(await readFile(path, "utf8")).language, "en");
  assert.deepEqual(h.errors, []);
});

test("unsupported configuration language fails closed without rewriting the file", async (t) => {
  const bad = { enabled: true, language: "fr", rules: testConfig.rules };
  const h = await setup(t, { config: bad, responses: ["failure"] });
  await h.session.prompt("Test");
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(h.dir, "retry-rules.json"), "utf8")), bad);
  assert.deepEqual(h.errors, []);
});

test("Chinese manual retry notices and native settings retain the selected language", async (t) => {
  const ui = dialogs({ selections: ["pi 原生重试参数", "当前项目"], confirmations: [true] });
  ui.editor = async (_title, prefill) => prefill;
  const h = await setup(t, { config: { ...disabled, language: "zh-CN" }, uiContext: ui, fileSettings: true });
  await h.session.prompt("/retry");
  assert.ok(ui.notifications.some((n) => n.text === "最后一条模型对话不是助手错误，未发起重试。"));
  await h.session.prompt("/retry-rules");
  assert.ok(ui.notifications.some((n) => n.text.startsWith("原生重试参数已保存")));
  let steps = 0;
  ui.select = async (_title, choices) => {
    assert.ok(choices.includes("语言"));
    return steps++ === 0 ? "查看配置" : "退出";
  };
  await h.session.prompt("/retry-rules");
  assert.equal(JSON.parse(await readFile(join(h.dir, "retry-rules.json"), "utf8")).language, "zh-CN");
  assert.deepEqual(h.errors, []);
});

test("release sources load without a local node_modules or packaged user configuration", async (t) => {
  const releaseDir = await mkdtemp(join(tmpdir(), "pi-retry-release-"));
  t.after(() => rm(releaseDir, { recursive: true, force: true }));
  for (const file of ["index.js", "rules.js", "i18n.js", "package.json"]) await cp(join(root, file), join(releaseDir, file));
  const ui = dialogs({ selections: ["Language", "简体中文", "退出"] });
  const h = await setup(t, { extensionPath: join(releaseDir, "index.js"), uiContext: ui, useDefaultConfig: true });
  await h.session.prompt("/retry-rules");
  assert.deepEqual(JSON.parse(await readFile(join(h.dir, "pi-retry-rules.json"), "utf8")), { enabled: false, language: "zh-CN", rules: [] });
  await assert.rejects(readFile(join(releaseDir, "pi-retry-rules.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(releaseDir, "retry-rules.json")), { code: "ENOENT" });
  assert.deepEqual(h.errors, []);
});

test("idle and configuration saves show no persistent rule-count banner", async (t) => {
  const ui = dialogs({ selections: ["Disable automatic rules", "Exit"] });
  const h = await setup(t, { uiContext: ui });
  assert.ok(ui.statuses.every((status) => status.key === "pi-retry-rules" && status.text === undefined));
  await h.session.prompt("/retry-rules");
  assert.ok(ui.statuses.every((status) => status.text === undefined));
  await h.session.prompt("/retry");
  assert.ok(ui.statuses.every((status) => status.text === undefined));
});

test("automatic retry status follows native attempt budget and clears on exhaustion", async (t) => {
  const ui = dialogs();
  const h = await setup(t, { uiContext: ui, responses: ["failure"] });
  await h.session.prompt("Test");
  assert.deepEqual(ui.statuses.filter((status) => status.text).map((status) => status.text),
    ["Retry in progress (1/2)", "Retry in progress (2/2)"]);
  assert.deepEqual(h.events.filter((event) => event.type === "auto_retry_start").map((event) => event.attempt), [1, 2]);
  assert.equal(ui.statuses.at(-1).text, undefined);
  assert.deepEqual(h.errors, []);
});

test("retry status remains visible during backoff and request, then clears on success", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const ui = dialogs();
  const h = await setup(t, { uiContext: ui, responses: ["failure", "success"],
    providerGate: async (attempt) => { if (attempt === 2) { started(); await gate; } } });
  const backoff = new Promise((resolve) => h.session.subscribe((event) => {
    if (event.type === "auto_retry_start") resolve();
  }));
  const running = h.session.prompt("Test");
  await backoff;
  assert.equal(ui.statuses.at(-1).text, "Retry in progress (1/2)");
  await requestStarted;
  assert.equal(ui.statuses.at(-1).text, "Retry in progress (1/2)");
  release();
  await running;
  assert.equal(ui.statuses.at(-1).text, undefined);
  assert.deepEqual(h.errors, []);
});

test("cancellation clears automatic retry status without making a request", async (t) => {
  const ui = dialogs();
  const h = await setup(t, { uiContext: ui, retry: { baseDelayMs: 60000, maxAgentDelayMs: 60000 } });
  const backoff = new Promise((resolve) => h.session.subscribe((event) => {
    if (event.type === "auto_retry_start") resolve();
  }));
  const running = h.session.prompt("Test");
  await backoff;
  assert.equal(ui.statuses.at(-1).text, "Retry in progress (1/2)");
  await h.session.abort();
  await running;
  assert.equal(ui.statuses.at(-1).text, undefined);
  assert.equal(h.requests.length, 1);
});

test("manual retry displays single-attempt status in the selected language", async (t) => {
  for (const language of ["en", "zh-CN"]) {
    const ui = dialogs();
    const h = await setup(t, { uiContext: ui, config: { ...disabled, language }, responses: [opaqueFailure, "success"] });
    await h.session.prompt("Test");
    await manualRetry(h);
    assert.deepEqual(ui.statuses.filter((status) => status.text).map((status) => status.text),
      [language === "en" ? "Manual retry in progress (1/1)" : "手动重试中（第 1/1 次）"]);
    assert.equal(ui.statuses.at(-1).text, undefined);
  }
});

test("manual retry hands status over to native retries and resets on the next operation", async (t) => {
  const ui = dialogs();
  const h = await setup(t, { uiContext: ui, responses: [opaqueFailure, "failure", "success", "failure", "success"] });
  await h.session.prompt("Test");
  await manualRetry(h);
  assert.deepEqual(ui.statuses.filter((status) => status.text).map((status) => status.text),
    ["Manual retry in progress (1/1)", "Retry in progress (1/2)"]);
  ui.statuses.length = 0;
  await h.session.prompt("Next request");
  assert.deepEqual(ui.statuses.filter((status) => status.text).map((status) => status.text), ["Retry in progress (1/2)"]);
  assert.equal(ui.statuses.at(-1).text, undefined);
});

test("Chinese automatic retry status clears on success and does not return after reload", async (t) => {
  const ui = dialogs();
  const h = await setup(t, { uiContext: ui, config: { ...testConfig, language: "zh-CN" } });
  await h.session.prompt("Test");
  assert.deepEqual(ui.statuses.filter((status) => status.text).map((status) => status.text), ["重试中（第 1/2 次）"]);
  assert.equal(ui.statuses.at(-1).text, undefined);
  ui.statuses.length = 0;
  assert.ok(ui.statuses.every((status) => status.text === undefined));
});

test("native retry status works without custom rules and resets after a successful tool response", async (t) => {
  const ui = dialogs();
  const h = await setup(t, { uiContext: ui, config: disabled,
    responses: ["rate_limit_exceeded 429", "tool", "rate_limit_exceeded 429", "success"] });
  await h.session.prompt("Test");
  assert.deepEqual(ui.statuses.filter((status) => status.text).map((status) => status.text),
    ["Retry in progress (1/2)", "Retry in progress (1/2)"]);
  assert.deepEqual(h.events.filter((event) => event.type === "auto_retry_start").map((event) => event.attempt), [1, 1]);
  assert.equal(h.toolRuns(), 1);
  assert.equal(ui.statuses.at(-1).text, undefined);
  assert.deepEqual(h.errors, []);
});

test("manual retry status clears on unmatched failure or aborted response", async (t) => {
  for (const response of [opaqueFailure, "aborted"]) {
    const ui = dialogs();
    const h = await setup(t, { uiContext: ui, config: disabled, responses: [opaqueFailure, response] });
    await h.session.prompt("Test");
    await manualRetry(h);
    assert.deepEqual(ui.statuses.filter((status) => status.text).map((status) => status.text), ["Manual retry in progress (1/1)"]);
    assert.equal(ui.statuses.at(-1).text, undefined);
  }
});
