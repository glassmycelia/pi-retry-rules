import test from "node:test";
import assert from "node:assert/strict";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { translate } from "../i18n.js";
import { applyRetryRules, DEFAULT_CONFIG, parseConfig, parseNativeRetry, RETRY_HINT } from "../rules.js";

const config = parseConfig({ enabled: true, rules: [{ provider: "test-provider", model: "test-model",
  contains: ["Gateway API error (400):", "temporary upstream rejection", "invalid_request_error"] }] });
const error = 'Gateway API error (400): {"code":null,"message":"temporary upstream rejection","param":null,"type":"invalid_request_error"}';
const message = {
  role: "assistant", provider: "test-provider", model: "test-model", api: "openai-responses",
  stopReason: "error", errorMessage: error, content: [], timestamp: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

test("matched error becomes retryable without losing the original message or fields", () => {
  const replacement = applyRetryRules(message, config, 100000);
  assert.equal(isRetryableAssistantError(message), false);
  assert.equal(isRetryableAssistantError(replacement), true);
  assert.equal(replacement.errorMessage, error + RETRY_HINT);
  assert.deepEqual(replacement, { ...message, errorMessage: error + RETRY_HINT });
  assert.equal(message.errorMessage, error);
  assert.equal(applyRetryRules(replacement, config), undefined);
});

test("provider, model and every case-sensitive contains term must match", () => {
  for (const overrides of [
    { provider: "other" }, { model: "other" }, { errorMessage: error.replace("400", "401") },
    { errorMessage: error.replace("invalid_request_error", "other") },
    { errorMessage: error.replace("temporary", "TEMPORARY") },
  ]) assert.equal(applyRetryRules({ ...message, ...overrides }, config), undefined);
  const anyModel = parseConfig({ enabled: true, rules: [{ provider: "test-provider", contains: ["(400)"] }] });
  assert.ok(applyRetryRules({ ...message, model: "other" }, anyModel));
});

test("disabled rules, successful responses, tool results and cancellation are untouched", () => {
  assert.equal(applyRetryRules(message, { ...config, enabled: false }), undefined);
  assert.equal(applyRetryRules(message, { enabled: true, rules: [] }), undefined);
  for (const stopReason of ["stop", "toolUse", "aborted"]) {
    assert.equal(applyRetryRules({ ...message, stopReason }, config), undefined);
  }
  assert.equal(applyRetryRules({ role: "toolResult", content: [] }, config), undefined);
  assert.equal(applyRetryRules({ ...message, errorMessage: undefined }, config), undefined);
});

test("native retryable errors, fatal provider limits and context overflow are not reclassified", () => {
  const broad = parseConfig({ enabled: true, rules: [{ provider: "test-provider", contains: ["error"] }] });
  for (const errorMessage of [
    "error: rate_limit_exceeded (429)", "error: insufficient_quota (429)", "error: quota exceeded",
    "error: billing unavailable", "error: GoUsageLimitError", "error: FreeUsageLimitError",
    'error: {"code":1308}', "error: context_length_exceeded", "error: maximum context length exceeded",
    "error: HTTP 401", "error: HTTP 403", "error: authentication_error", "error: invalid_api_key",
    "error: unauthorized", "error: permission_denied",
  ]) assert.equal(applyRetryRules({ ...message, errorMessage }, broad, 100000), undefined, errorMessage);
});

test("invalid configurations are rejected rather than silently broadening rules", () => {
  for (const value of [
    null, [], {}, { enabled: "yes", rules: [] }, { enabled: true, rules: {}, },
    { enabled: true, rules: [], unknown: true },
    ...[null, {}, { provider: "", contains: ["x"] }, { provider: "p", model: "", contains: ["x"] },
      { provider: "p", contains: [] }, { provider: "p", contains: [""] },
      { provider: "p", contains: [1] }, { provider: "p", contains: ["x"], pattern: ".*" }]
      .map((rule) => ({ enabled: true, rules: [rule] })),
  ]) assert.throws(() => parseConfig(value));
});

test("native retry editor rejects invalid counts, delays and unknown fields", () => {
  const valid = { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000,
    provider: { maxRetries: 0, maxRetryDelayMs: 60000 } };
  assert.deepEqual(parseNativeRetry(valid), valid);
  assert.deepEqual(parseNativeRetry({ ...valid, provider: { ...valid.provider, timeoutMs: 0 } }).provider.timeoutMs, 0);
  for (const overrides of [
    { enabled: "yes" }, { maxRetries: -1 }, { maxRetries: 1.5 }, { maxRetries: Number.MAX_SAFE_INTEGER + 1 },
    { baseDelayMs: -1 }, { baseDelayMs: 2147483648 }, { maxAgentDelayMs: Infinity },
    { unknown: true }, { provider: null }, { provider: [] },
    { provider: { ...valid.provider, maxRetries: -1 } }, { provider: { ...valid.provider, timeoutMs: -1 } },
    { provider: { ...valid.provider, maxRetryDelayMs: "60000" } },
  ]) assert.throws(() => parseNativeRetry({ ...valid, ...overrides }));
});

test("public defaults are opt-in, English and independent of any provider", () => {
  assert.deepEqual(parseConfig(DEFAULT_CONFIG), { enabled: false, language: "en", rules: [] });
  assert.equal(parseConfig({ enabled: true, rules: [] }).language, "en");
  assert.equal(parseConfig({ enabled: false, language: "zh-CN", rules: [] }).language, "zh-CN");
  for (const language of ["auto", "fr", "", null, 1]) {
    assert.throws(() => parseConfig({ enabled: false, language, rules: [] }));
  }
});

test("translations support interpolation, English fallback and opaque user data", () => {
  assert.equal(translate("en", "Language"), "Language");
  assert.equal(translate("zh-CN", "Language"), "语言");
  assert.equal(translate("zh-CN", "Session configuration: {path}. Resume and reload preserve it; use --retry-rules-config for new sessions.",
    { path: "{secret}/rules.json" }), "本会话配置：{secret}/rules.json。恢复和重载会保留；新会话可用 --retry-rules-config 指定。");
  assert.equal(translate("zh-CN", "Untranslated message"), "Untranslated message");
});
