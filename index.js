import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { applyRetryRules, DEFAULT_CONFIG, parseConfig, parseNativeRetry } from "./rules.js";
import { languages, translate } from "./i18n.js";

const manualRetryType = "pi-retry-rules:manual-retry";
const configPathType = "pi-retry-rules:config-path";

export default function retryRules(pi) {
  const defaultConfigPath = resolve(getAgentDir(), "pi-retry-rules.json");
  let config = parseConfig(DEFAULT_CONFIG);
  let configPath = defaultConfigPath;
  let loadedText;
  let configValid = false;
  let editing = false;
  let retryAttempt = 0;
  let retryStatus;

  const t = (text, values) => translate(config.language, text, values);
  const notify = (ctx, text, level = "info") => {
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else console.error(text);
  };
  const updateStatus = (ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("pi-retry-rules", retryStatus
      ? t(retryStatus.manual ? "Manual retry in progress ({attempt}/{max})" : "Retry in progress ({attempt}/{max})",
        { attempt: retryStatus.attempt, max: retryStatus.max })
      : undefined);
  };
  const warnIfRetryDisabled = (ctx) => {
    if (config.enabled && pi.getSettings().retry?.enabled === false) {
      notify(ctx, t("Pi's native retry is disabled; rules cannot enable it."), "warning");
    }
  };
  const clearRetryStatus = (ctx) => {
    retryAttempt = 0;
    retryStatus = undefined;
    updateStatus(ctx);
  };
  pi.on("before_agent_start", (event, ctx) => {
    if (event.messageType !== "custom" || event.message.customType !== manualRetryType) clearRetryStatus(ctx);
  });
  pi.on("agent_end", (event, ctx) => {
    const last = event.messages.findLast((message) => message.role === "assistant");
    const settings = SettingsManager.inMemory(pi.getSettings()).getRetrySettings();
    // Pi's retry events are host-only; observe the same eligibility and budget without scheduling any work.
    if (ctx.signal?.aborted || !last || !settings.enabled || retryAttempt >= settings.maxRetries
      || isContextOverflow(last, ctx.model?.contextWindow ?? 0) || !isRetryableAssistantError(last)) {
      clearRetryStatus(ctx);
      return;
    }
    retryStatus = { attempt: ++retryAttempt, max: settings.maxRetries, manual: false };
    updateStatus(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => clearRetryStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) => clearRetryStatus(ctx));

  const loadConfig = async (ctx) => {
    const previousLanguage = config.language;
    config = parseConfig(DEFAULT_CONFIG);
    configValid = false;
    loadedText = undefined;
    try {
      loadedText = await readFile(configPath, "utf8");
      config = parseConfig(JSON.parse(loadedText));
      configValid = true;
    } catch (error) {
      if (error.code === "ENOENT") {
        configValid = true;
      } else {
        config.language = previousLanguage;
        // Do not echo malformed configuration contents, which could contain credentials.
        notify(ctx, t("Retry rules disabled: cannot read or validate {path}", { path: configPath }), "error");
      }
    }
    updateStatus(ctx);
    warnIfRetryDisabled(ctx);
  };
  const saveConfig = async (next, ctx, repair = false) => {
    if (!configValid && !repair) {
      notify(ctx, t("Configuration is invalid. Repair it with Edit full configuration JSON or reload a corrected file."), "error");
      return false;
    }
    const tempPath = `${configPath}.${randomUUID()}.tmp`;
    const lockPath = `${configPath}.lock`;
    let lock;
    try {
      const validated = parseConfig(next);
      await mkdir(dirname(configPath), { recursive: true });
      // shortcut: a crash can leave this lock; remove it only after confirming no session is saving.
      lock = await open(lockPath, "wx", 0o600);
      const text = JSON.stringify(validated, null, 2) + "\n";
      await writeFile(tempPath, text, { flag: "wx", mode: 0o600 });
      let latest;
      try { latest = await readFile(configPath, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (latest === undefined && loadedText !== undefined) throw new Error("Configuration removed");
      if (latest !== loadedText) {
        notify(ctx, t("Configuration changed in another session or editor. Reload it before saving."), "warning");
        return false;
      }
      // Replace only a fully written, validated file; failed saves leave the active rules unchanged.
      await rename(tempPath, configPath);
      config = validated;
      configValid = true;
      loadedText = text;
      updateStatus(ctx);
      warnIfRetryDisabled(ctx);
      notify(ctx, t("Retry rules saved and applied immediately."));
      return true;
    } catch (error) {
      if (!lock && error.code === "EEXIST") {
        notify(ctx, t("Another session is saving. Retry later. If no writer is active, remove the stale lock: {path}", { path: lockPath }), "warning");
      } else {
        notify(ctx, t("Cannot save retry configuration: {path}. Active rules are unchanged.", { path: configPath }), "error");
      }
      return false;
    } finally {
      try {
        await rm(tempPath, { force: true });
      } finally {
        if (lock) {
          await lock.close();
          await rm(lockPath, { force: true });
        }
      }
    }
  };

  pi.registerFlag("retry-rules-config", {
    description: "Path to user retry rules JSON; defaults to <Pi agent directory>/pi-retry-rules.json. Configure with /retry-rules.",
    type: "string",
    default: defaultConfigPath,
  });

  const restoreConfig = async (_event, ctx) => {
    editing = false;
    retryAttempt = 0;
    retryStatus = undefined;
    const selected = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom"
      && entry.customType === configPathType && typeof entry.data?.path === "string");
    configPath = selected?.data.path ?? resolve(ctx.cwd, pi.getFlag("retry-rules-config") || defaultConfigPath);
    await loadConfig(ctx);
  };
  pi.on("session_start", restoreConfig);
  pi.on("session_tree", restoreConfig);

  const chooseRule = async (ctx) => {
    if (config.rules.length === 0) {
      notify(ctx, t("No rules configured."));
      return undefined;
    }
    const labels = config.rules.map((rule, i) => t("{index}. {provider} / {model} ({count} matching terms)",
      { index: i + 1, provider: rule.provider, model: rule.model ?? t("All models"), count: rule.contains.length }));
    const choice = await ctx.ui.select(t("Select a rule"), labels);
    return choice === undefined ? undefined : labels.indexOf(choice);
  };
  const editRule = async (ctx, existing) => {
    const provider = await ctx.ui.editor(t("Provider ID (exact match)"), existing?.provider ?? ctx.model?.provider ?? "");
    if (provider === undefined) return undefined;
    const model = await ctx.ui.editor(t("Model ID (exact match; blank matches all models of this provider)"), existing ? existing.model ?? "" : ctx.model?.id ?? "");
    if (model === undefined) return undefined;
    const contains = await ctx.ui.editor(t("Matching text (one term per line; ALL must match; case-sensitive)"), existing?.contains.join("\n") ?? "");
    if (contains === undefined) return undefined;
    try {
      return parseConfig({ enabled: config.enabled, language: config.language, rules: [{ provider: provider.trim(),
        ...(model.trim() ? { model: model.trim() } : {}),
        contains: contains.split("\n").filter((text) => text.trim().length > 0) }] }).rules[0];
    } catch {
      notify(ctx, t("Provider and at least one matching term are required. Nothing saved."), "error");
      return undefined;
    }
  };

  const selectConfigPath = async (ctx) => {
    const input = await ctx.ui.editor(t("Configuration path (this session; blank restores the startup path)"), configPath);
    if (input === undefined) return;
    const entered = input.trim() || pi.getFlag("retry-rules-config") || defaultConfigPath;
    const nextPath = resolve(ctx.cwd, entered.startsWith("~/") ? resolve(homedir(), entered.slice(2)) : entered);
    try {
      const text = await readFile(nextPath, "utf8");
      const next = parseConfig(JSON.parse(text));
      configPath = nextPath;
      loadedText = text;
      config = next;
      configValid = true;
    } catch (error) {
      if (error.code !== "ENOENT") {
        notify(ctx, t("Cannot read or validate the target configuration. Path unchanged; file not overwritten."), "error");
        return;
      }
      if (!await ctx.ui.confirm(t("Create configuration file?"), t("Copy current rules to {path} and use it in this session.", { path: nextPath }))) return;
      try {
        await mkdir(dirname(nextPath), { recursive: true });
        const text = JSON.stringify(config, null, 2) + "\n";
        await writeFile(nextPath, text, { flag: "wx", mode: 0o600 });
        configPath = nextPath;
        loadedText = text;
        configValid = true;
      } catch {
        notify(ctx, t("Cannot create target configuration. Path unchanged."), "error");
        return;
      }
    }
    pi.appendEntry(configPathType, { path: configPath });
    updateStatus(ctx);
    warnIfRetryDisabled(ctx);
    notify(ctx, t("Session configuration: {path}. Resume and reload preserve it; use --retry-rules-config for new sessions.", { path: configPath }));
  };

  const editNativeRetry = async (ctx) => {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      notify(ctx, t("Wait until requests and pending messages finish before editing native retry settings."), "warning");
      return false;
    }
    const settings = pi.getSettings();
    const snapshot = SettingsManager.inMemory(settings);
    const initial = { ...snapshot.getRetrySettings(), provider: { ...snapshot.getProviderRetrySettings(),
      maxRetries: snapshot.getProviderRetrySettings().maxRetries ?? 0 } };
    const input = await ctx.ui.editor(t("Pi native retry JSON (delays/timeouts in ms; save to project or user settings, then reload)"), JSON.stringify(initial, null, 2));
    if (input === undefined) return false;
    let next;
    try {
      next = parseNativeRetry(JSON.parse(input));
    } catch {
      notify(ctx, t("Invalid native retry settings. Counts must be nonnegative integers; milliseconds must be between 0 and 2147483647."), "error");
      return false;
    }
    const projectScope = t("Current project");
    const scope = await ctx.ui.select(t("Save scope (affects Pi and every extension using native retries)"), [projectScope, t("User settings")]);
    if (scope === undefined) return false;
    if (scope === projectScope && !ctx.isProjectTrusted()) {
      notify(ctx, t("Project is not trusted. Project settings cannot be changed."), "warning");
      return false;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      notify(ctx, t("Requests or pending messages appeared. Native settings were not saved."), "warning");
      return false;
    }
    if (!await ctx.ui.confirm(t("Save and reload Pi?"), t("Update retry settings in {scope}. Other settings are preserved. Project settings may override user settings.", { scope }))) return false;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      notify(ctx, t("Requests or pending messages appeared. Native settings were not saved."), "warning");
      return false;
    }
    const path = scope === projectScope ? resolve(ctx.cwd, ".pi/settings.json") : resolve(getAgentDir(), "settings.json");
    let current;
    let merged;
    try {
      try { current = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const existing = current === undefined ? {} : JSON.parse(current);
      if (!existing || typeof existing !== "object" || Array.isArray(existing)
        || (existing.retry !== undefined && (!existing.retry || typeof existing.retry !== "object" || Array.isArray(existing.retry)))
        || (existing.retry?.provider !== undefined && (!existing.retry.provider || typeof existing.retry.provider !== "object" || Array.isArray(existing.retry.provider)))) throw new Error("Invalid settings");
      merged = { ...existing, retry: { ...existing.retry, ...next, provider: { ...existing.retry?.provider, ...next.provider } } };
      if (next.provider.timeoutMs === undefined) delete merged.retry.provider.timeoutMs;
      // Validate before touching disk; preserve unrelated settings and provider options.
      const validated = SettingsManager.inMemory(merged);
      validated.getRetrySettings();
      validated.getProviderRetrySettings();
    } catch {
      notify(ctx, t("Cannot read or validate Pi settings. Original file preserved."), "error");
      return false;
    }
    const temp = `${path}.${randomUUID()}.tmp`;
    const lockPath = `${path}.lock`;
    let locked = false;
    try {
      await mkdir(dirname(path), { recursive: true });
      // Use the same lock directory as Pi's settings writer.
      await mkdir(lockPath, { mode: 0o700 });
      locked = true;
      let latest;
      try { latest = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (latest !== current) {
        notify(ctx, t("Pi settings changed elsewhere. Reopen the menu."), "warning");
        return false;
      }
      await writeFile(temp, JSON.stringify(merged, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temp, path);
    } catch {
      notify(ctx, t("Cannot save native retry settings. Pi was not reloaded."), "error");
      return false;
    } finally {
      try { await rm(temp, { force: true }); } finally {
        if (locked) await rm(lockPath, { recursive: true, force: true });
      }
    }
    notify(ctx, t("Native retry settings saved. Reloading Pi; check effective values if project overrides exist."));
    await ctx.reload();
    return true;
  };

  pi.registerCommand("retry-rules", {
    description: "Edit retry rules, language, configuration path and Pi native retry settings",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        notify(ctx, t("Interactive configuration requires TUI or RPC. Configuration file: {path}", { path: configPath }), "warning");
        return;
      }
      if (editing) return;
      editing = true;
      try {
        while (true) {
          const toggle = config.enabled ? "Disable automatic rules" : "Enable automatic rules";
          const actions = [toggle, "Add rule", "Edit rule", "Delete rule", "Edit full configuration JSON",
            "Configuration path", "Pi native retry settings", "Language", "View configuration", "Reload configuration", "Exit"];
          const labels = actions.map((action) => t(action));
          const choice = await ctx.ui.select(t("Retry rules · {state} · {count} rules", { state: t(config.enabled ? "on" : "off"), count: config.rules.length }), labels);
          const action = actions[labels.indexOf(choice)];
          if (action === undefined || action === "Exit") return;
          if (action === "Language") {
            const language = await ctx.ui.select(t("Language"), Object.values(languages));
            const key = Object.keys(languages).find((key) => languages[key] === language);
            if (key) await saveConfig({ ...config, language: key }, ctx);
          } else if (action === "View configuration") {
            const native = SettingsManager.inMemory(pi.getSettings());
            notify(ctx, t("Configuration path: {path}\n{config}\nPi native settings:\n{native}", { path: configPath,
              config: JSON.stringify(config, null, 2), native: JSON.stringify({ ...native.getRetrySettings(), provider: native.getProviderRetrySettings() }, null, 2) }));
          } else if (action === "Pi native retry settings") {
            if (await editNativeRetry(ctx)) return;
          } else if (action === "Configuration path") {
            await selectConfigPath(ctx);
          } else if (action === "Edit full configuration JSON") {
            const input = await ctx.ui.editor(t("Full retry configuration JSON"), JSON.stringify(config, null, 2));
            if (input === undefined) continue;
            let next;
            try { next = parseConfig(JSON.parse(input)); } catch {
              notify(ctx, t("Invalid rule JSON. Nothing saved."), "error");
              continue;
            }
            if (!configValid && !await ctx.ui.confirm(t("Repair configuration file?"),
              t("Replace invalid configuration at {path} with the validated JSON?", { path: configPath }))) continue;
            await saveConfig(next, ctx, !configValid);
          } else if (action === "Reload configuration") {
            await loadConfig(ctx);
          } else if (action === toggle) {
            await saveConfig({ ...config, enabled: !config.enabled }, ctx);
          } else if (action === "Add rule") {
            const rule = await editRule(ctx);
            if (rule) await saveConfig({ ...config, rules: [...config.rules, rule] }, ctx);
          } else {
            const index = await chooseRule(ctx);
            if (index === undefined || index < 0) continue;
            const rules = [...config.rules];
            if (action === "Edit rule") {
              const rule = await editRule(ctx, rules[index]);
              if (!rule) continue;
              rules[index] = rule;
            } else if (action === "Delete rule") {
              if (!await ctx.ui.confirm(t("Delete this rule?"), t("Delete rule {index}. Changes apply immediately after saving.", { index: index + 1 }))) continue;
              rules.splice(index, 1);
            }
            await saveConfig({ ...config, rules }, ctx);
          }
        }
      } finally {
        editing = false;
      }
    },
  });

  pi.registerCommand("retry", {
    description: "Retry the last assistant error once, without adding a user message",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        notify(ctx, t("Wait until the current request, retry and pending messages finish before /retry."), "warning");
        return;
      }
      const projection = ctx.sessionManager.buildSessionProjection();
      const last = projection.messages.filter((message) => message.role !== "system" && message.role !== "bashExecution").at(-1);
      if (last?.role !== "assistant" || last.stopReason !== "error") {
        notify(ctx, t("The last model message is not an assistant error. No retry started."), "warning");
        return;
      }
      if (!ctx.model) {
        notify(ctx, t("Select a model first."), "warning");
        return;
      }
      const target = projection.entries.findLast((entry) => entry.messages.includes(last));
      if (!target) return;
      retryStatus = { attempt: 1, max: 1, manual: true };
      updateStatus(ctx);
      // shortcut: Pi exposes no idle retry entrypoint; a filtered control message starts one run via the public API.
      try {
        pi.sendMessage({ customType: manualRetryType, content: [], display: false,
          details: { targetId: target.sourceEntry.id } }, { triggerTurn: true });
      } catch (error) {
        clearRetryStatus(ctx);
        throw error;
      }
    },
  });

  const manualMarkers = (entries) => entries.filter((entry) => entry.type === "custom_message"
    && entry.customType === manualRetryType && typeof entry.details?.targetId === "string");

  const filterManualContext = (event, ctx) => {
    const markers = manualMarkers(ctx.sessionManager.getBranch());
    if (markers.length === 0) return undefined;
    const messages = event.messages.filter((message) => message.role !== "custom" || message.customType !== manualRetryType);
    const projection = ctx.sessionManager.buildSessionProjection();
    for (const marker of markers) {
      const target = projection.entries.find((entry) => entry.sourceEntry.id === marker.details.targetId);
      for (const failed of target?.messages ?? []) {
        if (failed.role !== "assistant" || failed.stopReason !== "error") continue;
        const serialized = JSON.stringify(failed);
        const index = messages.findLastIndex((message) => JSON.stringify(message) === serialized);
        if (index >= 0) messages.splice(index, 1);
      }
    }
    return { messages };
  };
  pi.on("context", filterManualContext);
  pi.on("context_with_system", filterManualContext);

  const persistManualOmissions = (event, ctx) => {
    const markers = manualMarkers(ctx.sessionManager.getBranch());
    const omitted = new Set(ctx.sessionManager.getBranch().filter((entry) => entry.type === "context_edit"
      && entry.replacement === null).map((entry) => entry.targetId));
    const entries = [...event.entries];
    for (const marker of markers) {
      const failed = ctx.sessionManager.getEntry(marker.details.targetId);
      const targets = [marker.id];
      if (failed?.type === "message" && failed.message.role === "assistant" && failed.message.stopReason === "error") targets.push(failed.id);
      for (const targetId of targets) {
        if (omitted.has(targetId) || entries.some((entry) => entry.type === "context_edit" && entry.targetId === targetId)) continue;
        entries.push({ type: "context_edit", targetId, replacement: null });
        omitted.add(targetId);
      }
    }
    return entries.length === event.entries.length ? undefined : { entries };
  };
  pi.on("turn_end", persistManualOmissions);
  pi.on("agent_before_settle", persistManualOmissions);

  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant" && event.message.stopReason !== "error") clearRetryStatus(ctx);
    if (pi.getSettings().retry?.enabled === false) return undefined;
    // shortcut: Pi has no retry-decision hook; retain the error and add a native-recognized hint until one exists.
    const message = applyRetryRules(event.message, config, ctx.model?.contextWindow ?? 0);
    return message ? { message } : undefined;
  });
}
