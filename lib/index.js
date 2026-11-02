/**
 * dsh-san-sheng-liu-bu (三省六部制流程优化插件) — pick a reasoning-effort gear per turn from the task's difficulty.
 *
 * Gear contract (all configurable):
 *   simple  → reasoningEffort off/low  + a reduced tool surface
 *   medium  → reasoningEffort low      (all tools kept)
 *   complex → reasoningEffort high     (nothing reduced)
 *   uncertain → ask the user once with a countdown card, then act on the answer
 *
 * Hook points (see @deepseek-ai/dsh-agent-loop):
 *   agent/inbox/claimed  emitted synchronously inside preStep *before* the step's
 *                        tool schemas are assembled → the only place where a
 *                        tool restriction can still shape the current step.
 *   agent/pre-step       awaited waterfall; used for the interactive question.
 *   agent/request        waterfall over the per-request model config; used for
 *                        reasoningEffort (validated against the model catalog).
 */

import z from "@deepseek-ai/schemastery";
import { classify, isContinuation } from "./classify.js";

const name = "san-sheng-liu-bu";
const inject = [];

/** Tools hidden for simple turns: infrastructure that a short task never needs. */
const DEFAULT_DENY = [
  // web
  "web_search",
  "web_fetch",
  // delegation / teams
  "subagent",
  "subagent_fork",
  "workflow",
  "ralph",
  "spawn_teammate",
  "send_message",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
  "team_task_create",
  "team_task_get",
  "team_task_list",
  "team_task_update",
  // terminals / jobs
  "terminal_open",
  "terminal_send",
  "terminal_read",
  "terminal_list",
  "terminal_close",
  "terminal_signal",
  "job_list",
  "job_output",
  "job_kill",
  // scheduling
  "schedule_create",
  "schedule_update",
  "schedule_list",
  "schedule_delete",
  // session / memory archaeology
  "session_search",
  "session_event_search",
  "session_event_read",
  "session_event_trace",
  "session_trace",
  "hindsight_capture_initiative",
  "hindsight_diagnose",
  "hindsight_ingest_document",
  "hindsight_list_knowledge_pages",
  "hindsight_read_knowledge_page",
  "hindsight_reflect",
  "hindsight_search_knowledge_pages",
  "hindsight_sync_status",
  // context-cache introspection
  "acp_cache",
  "acp_status",
  "acp_read_original_image",
  // goals
  "create_goal",
  "update_goal",
  "get_goal",
  // media / UI
  "modlens_read_image",
  "render_ui",
  "validate_dsh_ui",
  "present",
];

const Config = z.object({
  enabled: z.boolean().default(true),
  /** Reasoning effort for simple turns; "" leaves the request untouched. */
  simpleEffort: z.string().default("off"),
  /** Reasoning effort for medium turns. */
  mediumEffort: z.string().default("low"),
  /** Reasoning effort for complex turns (the profile default is "high"). */
  complexEffort: z.string().default("high"),
  /** "", "simple", "medium" or "complex": forces one gear and skips classification. */
  modeOverride: z.string().default(""),
  /** Hide the deny list's tools on simple turns (the other big latency lever). */
  restrictSimpleTools: z.boolean().default(true),
  /** Global tools hidden on simple turns; unknown names are ignored. */
  denyTools: z.array(z.string()).default(DEFAULT_DENY),
  /** Ask the user when the classifier is unsure; otherwise fall back to medium. */
  askOnUncertain: z.boolean().default(true),
  /** How long the countdown card waits before falling back to medium, in ms. */
  askTimeoutMs: z.number().default(90000),
  /** "继续/好的/ok" reuses the previous turn's gear instead of re-classifying. */
  continuationReuse: z.boolean().default(true),
  /** Verbose logging through ctx.logger. */
  debug: z.boolean().default(false),
});

/** Join the text parts of one message. */
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** A real root-agent user message, or undefined for everything else. */
function realUserText(payload) {
  const agent = payload?.agent;
  const message = payload?.message;
  if (agent === undefined || message === undefined) return undefined;
  // Delegated children carry a durable parentSession; they must never ask/steer.
  if (agent.session?.header?.parentSession !== undefined) return undefined;
  if (message.role !== "user") return undefined;
  if ((message.source ?? {}).kind !== "user") return undefined;
  const text = messageText(message).trim();
  return text.length === 0 ? undefined : text;
}

function effortFor(mode, config) {
  if (mode === "simple") return String(config.simpleEffort ?? "");
  if (mode === "medium") return String(config.mediumEffort ?? "");
  if (mode === "complex") return String(config.complexEffort ?? "");
  return "";
}

const EFFORT_RANK = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, max: 5 };

function apply(ctx, config) {
  const cfg = config ?? {};
  const states = new Map();
  const effortSupport = new Map();

  const log = (...args) => {
    if (!cfg.debug) return;
    try {
      const line = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
      ctx.logger?.debug?.("[san-sheng-liu-bu] " + line);
    } catch {
      /* logging must never break a turn */
    }
  };

  /** Drop the current turn's tool restriction, if any. */
  const lift = (agentId) => {
    const state = states.get(agentId);
    if (state === undefined) return;
    const disposer = state.disposer;
    state.disposer = undefined;
    if (typeof disposer !== "function") return;
    try {
      disposer();
    } catch {
      /* ignored: a stale restriction is harmless next to a failed turn */
    }
  };

  /** Restrict global tools for one agent scope; unknown names are dropped. */
  const restrictTools = (agent, names) => {
    try {
      const tools = agent?.ctx?.tools;
      if (tools === undefined || typeof tools.restrict !== "function") return undefined;
      const list = [...new Set(names)].filter((item) => typeof item === "string" && item.length > 0);
      if (list.length === 0) return undefined;
      try {
        return tools.restrict({ deny: list });
      } catch (error) {
        // `restrict` validates every name; recover the known ones and retry.
        const match = /known global tools: ([^]*)$/.exec(String(error?.message ?? ""));
        if (match === null) return undefined;
        const known = new Set(match[1].split(/,\s*/).map((item) => item.trim()).filter(Boolean));
        const kept = list.filter((item) => known.has(item));
        if (kept.length === 0) return undefined;
        return tools.restrict({ deny: kept });
      }
    } catch {
      return undefined;
    }
  };

  /** Supported reasoning efforts for one provider/model route (cached). */
  const supportedEfforts = async (provider, model, signal) => {
    const key = String(provider) + "\u0000" + String(model);
    const cached = effortSupport.get(key);
    if (cached !== undefined) return cached;
    let set;
    try {
      const llm = ctx.get("llm");
      if (llm === undefined || typeof llm.resolveModelInfo !== "function") return undefined;
      const info = await llm.resolveModelInfo(provider, model, signal);
      set = new Set((info?.reasoning?.efforts ?? []).map((effort) => effort.id));
    } catch (error) {
      if (signal?.aborted === true) return undefined;
      log("effort lookup failed", key, String(error));
      set = new Set();
    }
    effortSupport.set(key, set);
    return set;
  };

  /** Ask the user which gear to use. Resolves to a mode or undefined (timeout). */
  const askMode = async (agent, signal) => {
    try {
      const questions = ctx.get("userQuestions");
      if (questions === undefined) return undefined;
      const request = {
        agent,
        signal,
        questions: [
          {
            id: "difficulty",
            header: "选择任务难度",
            question: "这个任务的难度我不太确定。请选择本次使用哪档加速（超时按中等处理）？",
            options: [
              { label: "简单", description: "关闭深度思考 + 精简工具，最快最省" },
              { label: "中等", description: "低深度思考，保留全部工具" },
              { label: "复杂", description: "保持高深度思考，不做任何降级" },
            ],
          },
        ],
      };
      const timeoutMs = Number(cfg.askTimeoutMs);
      const callId = `san-sheng-liu-bu:${agent.id}:${Date.now()}`;
      let result;
      if (typeof questions.askTimed === "function") {
        const budget = Number.isSafeInteger(timeoutMs) ? Math.max(1000, Math.min(timeoutMs, 2147483647)) : 90000;
        result = await questions.askTimed(request, callId, budget);
      } else {
        result = await questions.ask(request);
      }
      if (result === undefined || result === null || result.pending === true) return undefined;
      const selected = result?.answers?.[0]?.selected?.[0];
      const custom = result?.answers?.[0]?.custom;
      const label = (typeof selected === "string" && selected) || (typeof custom === "string" ? custom : "");
      if (label === "简单") return "simple";
      if (label === "中等") return "medium";
      if (label === "复杂") return "complex";
      return undefined;
    } catch (error) {
      log("ask failed", String(error));
      return undefined;
    }
  };

  const forcedMode = () => {
    const forced = String(cfg.modeOverride ?? "").toLowerCase();
    return forced === "simple" || forced === "medium" || forced === "complex" ? forced : undefined;
  };

  /* ---------- classification: synchronous, before tool assembly ---------- */

  ctx.on(
    "agent/inbox/claimed",
    (payload) => {
      try {
        if (cfg.enabled === false) return;
        const agent = payload?.agent;
        const turn = payload?.turn;
        const text = realUserText(payload);
        if (agent === undefined || text === undefined) return;
        const state = states.get(agent.id) ?? {};
        states.set(agent.id, state);
        // A same-turn steer keeps the gear already chosen for this turn.
        if (state.turn === turn) {
          state.text = text;
          return;
        }
        lift(agent.id);
        const previous = state.mode;
        state.turn = turn;
        state.text = text;
        state.pendingAsk = false;

        const forced = forcedMode();
        let mode;
        let reason;
        if (forced !== undefined) {
          mode = forced;
          reason = "override";
        } else if (cfg.continuationReuse !== false && previous !== undefined && isContinuation(text)) {
          mode = previous;
          reason = "continuation";
        } else {
          const decision = classify(text);
          mode = decision.mode === "inherit" ? (previous ?? "medium") : decision.mode;
          reason = decision.reason;
        }

        state.previous = previous;
        if (mode === "ask") {
          if (cfg.askOnUncertain === false) {
            mode = "medium";
            reason += "-fallback";
          } else {
            state.pendingAsk = true;
            state.mode = "medium";
            state.reason = reason;
            log("turn", turn, "asks for difficulty", reason);
            return;
          }
        }
        state.mode = mode;
        state.reason = reason;
        if (mode === "simple" && cfg.restrictSimpleTools !== false) {
          state.disposer = restrictTools(agent, cfg.denyTools ?? DEFAULT_DENY);
        }
        log("turn", turn, "mode", mode, reason, text.slice(0, 60));
      } catch (error) {
        log("claimed handler failed", String(error));
      }
    },
    { prepend: true },
  );

  /* ---------- interactive fallback: ask once, then apply ---------- */

  ctx.on(
    "agent/pre-step",
    async (payload, next) => {
      try {
        const agent = payload?.agent;
        const state = agent === undefined ? undefined : states.get(agent.id);
        if (state !== undefined && state.pendingAsk === true && payload?.step === 1) {
          state.pendingAsk = false;
          const mode = (await askMode(agent, payload.signal)) ?? "medium";
          state.previous = state.mode;
          state.mode = mode;
          state.reason = "asked";
          lift(agent.id);
          if (mode === "simple" && cfg.restrictSimpleTools !== false) {
            state.disposer = restrictTools(agent, cfg.denyTools ?? DEFAULT_DENY);
          }
          log("asked →", mode);
        }
      } catch (error) {
        log("pre-step handler failed", String(error));
      }
      return next();
    },
    { prepend: true },
  );

  /* ---------- effort: final say over the per-request config ---------- */

  ctx.on(
    "agent/request",
    async (payload, next) => {
      const resolved = await next();
      try {
        if (cfg.enabled === false) return resolved;
        const state = payload?.agent === undefined ? undefined : states.get(payload.agent.id);
        const mode = state?.mode;
        if (mode === undefined) return resolved;
        const effort = effortFor(mode, cfg);
        if (effort.length === 0) return resolved;
        if (resolved === undefined || resolved.reasoningEffort === effort) return resolved;
        if (typeof resolved.provider !== "string" || typeof resolved.model !== "string") return resolved;
        const supported = await supportedEfforts(resolved.provider, resolved.model, payload.signal);
        if (supported === undefined) return resolved;
        if (!supported.has(effort)) {
          log("effort", effort, "unsupported on", resolved.provider, resolved.model, [...supported]);
          return resolved;
        }
        log("effort", resolved.reasoningEffort, "→", effort, "for", mode);
        return { ...resolved, reasoningEffort: effort };
      } catch (error) {
        log("request handler failed", String(error));
        return resolved;
      }
    },
    { prepend: true },
  );

  /* ---------- hygiene: never leave a restriction behind ---------- */

  ctx.on("agent/status", (payload) => {
    try {
      if (payload?.status === "idle" && payload?.agent?.id !== undefined) lift(payload.agent.id);
    } catch {
      /* ignored */
    }
  });

  /** Forget one agent's state when it is disposed. */
  const forget = (agent) => {
    try {
      if (agent?.id !== undefined) {
        lift(agent.id);
        states.delete(agent.id);
      }
    } catch {
      /* ignored */
    }
  };
  // "agent/disposed" is emitted by the agent registry; tolerate its absence.
  try {
    ctx.on("agent/disposed", (payload) => forget(payload?.agent));
  } catch {
    /* ignored */
  }
}

export default { name, inject, Config, apply };
export { Config, apply, inject, name };
