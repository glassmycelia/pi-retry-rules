import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";

export const RETRY_HINT = " [pi-retry-rules local policy: please retry your request]";
export const DEFAULT_CONFIG = { enabled: false, language: "en", rules: [] };

export function parseConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Retry configuration must be an object.");
  }
  if (Object.keys(value).some((key) => !["enabled", "language", "rules"].includes(key))) {
    throw new Error("Unknown retry configuration field.");
  }
  if (typeof value.enabled !== "boolean" || !Array.isArray(value.rules)) {
    throw new Error("Retry configuration needs enabled (boolean) and rules (array).");
  }
  if (value.language !== undefined && !["en", "zh-CN"].includes(value.language)) {
    throw new Error("Unsupported interface language.");
  }
  const rules = value.rules.map((rule, index) => {
    const validString = (text) => typeof text === "string" && text.trim().length > 0;
    if (!rule || typeof rule !== "object" || Array.isArray(rule)
      || Object.keys(rule).some((key) => !["provider", "model", "contains"].includes(key))
      || !validString(rule.provider)
      || (rule.model !== undefined && !validString(rule.model))
      || !Array.isArray(rule.contains) || rule.contains.length === 0
      || !rule.contains.every(validString)) {
      throw new Error(`Invalid retry rule at index ${index}: provider, optional model, and nonempty contains are required.`);
    }
    return { ...rule, contains: [...rule.contains] };
  });
  return { enabled: value.enabled, language: value.language ?? "en", rules };
}

export function parseNativeRetry(value) {
  const fields = ["enabled", "maxRetries", "baseDelayMs", "maxAgentDelayMs", "provider"];
  const delay = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647;
  const count = (n) => Number.isSafeInteger(n) && n >= 0;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.includes(key))
    || typeof value.enabled !== "boolean" || !count(value.maxRetries)
    || !delay(value.baseDelayMs) || !delay(value.maxAgentDelayMs)) {
    throw new Error("Invalid agent retry settings.");
  }
  const provider = value.provider;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)
    || Object.keys(provider).some((key) => !["timeoutMs", "maxRetries", "maxRetryDelayMs"].includes(key))
    || !count(provider.maxRetries) || !delay(provider.maxRetryDelayMs)
    || (provider.timeoutMs !== undefined && !delay(provider.timeoutMs))) {
    throw new Error("Invalid provider retry settings.");
  }
  return { ...value, provider: { ...provider } };
}

const NON_RETRYABLE_AUTH = /(?<![a-z0-9])(?:401|403)(?![a-z0-9])|authentication_error|invalid_api_key|invalid_access_token|unauthorized|permission_denied/i;

export function applyRetryRules(message, config, contextWindow = 0) {
  if (!config.enabled || message.role !== "assistant" || message.stopReason !== "error"
    || typeof message.errorMessage !== "string" || !message.errorMessage
    || message.errorMessage.endsWith(RETRY_HINT)
    || NON_RETRYABLE_AUTH.test(message.errorMessage)
    || isContextOverflow(message, contextWindow)
    || isRetryableAssistantError(message)) {
    return undefined;
  }
  const matches = config.rules.some((rule) => rule.provider === message.provider
    && (rule.model === undefined || rule.model === message.model)
    && rule.contains.every((text) => message.errorMessage.includes(text)));
  if (!matches) return undefined;

  // Keep Pi's fatal-error exclusions authoritative even when a configured rule matches.
  const replacement = { ...message, errorMessage: message.errorMessage + RETRY_HINT };
  return isRetryableAssistantError(replacement) ? replacement : undefined;
}
