/**
 * Task-difficulty classifier for dsh-adaptive-effort.
 *
 * Pure, synchronous and dependency-free: it runs inside the agent's
 * `agent/inbox/claimed` event, before the step's tool schemas are assembled,
 * so it must never perform I/O.
 *
 * The classifier is deliberately conservative: when the textual evidence is
 * mixed it returns `ask`, and the plugin asks the user which effort gear to
 * use instead of guessing.
 */

/** Whole-message continuation ("继续", "好的", "ok", ...). */
const CONTINUATION = /^(?:继续|接着|往下|继续吧|继续执行|好的|好|可以|行|嗯|对|是的|收到|明白|ok|okay|yes|yep|y|go|go on|continue|next|done)[。.!！?？,，~～\s]*$/i;

/** Heavy verbs whose presence strongly suggests multi-step work. */
const COMPLEX_VERBS = /分析|调研|排查|调试|诊断|优化|重构|改造|设计|实现|开发|编写|生成|部署|迁移|评估|评审|对比|总结|整理|报告|方案|审计|压测|联调|修复/g;

/** Verbs that usually prefix a quick single-fact answer. */
const SIMPLE_VERBS = /查一下|查查|是什么|什么意思|怎么读|翻译|多少钱|算一下|计算|等于|格式化|大小写|排序|列一下|列出|有没有|是不是|能不能|是否|几号|几点/g;

/** Words asking for a multi-part deliverable. */
const MULTI_PART = /分别|逐个|逐条|每一项|每个|清单|表格|目录|大纲|流程/g;

/** Paths, code fences and URLs imply tool work. */
const PATH_HINT = /(?:^|[\s(（"'`])(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/[A-Za-z0-9._-]+\/)/;
const URL_HINT = /https?:\/\//i;
const FENCE_HINT = /```/;

/** Greeting / acknowledgement openers that carry no work on their own. */
const GREETING = /^(?:你好|您好|hi|hello|hey|嗨|在吗|早安|晚安|谢谢|多谢|thanks|thank you|thx)/i;

/** Vague one-liners that name no concrete deliverable. */
const VAGUE = /^(?:请)?(?:帮我)?(?:看看|看一下|处理一下|弄一下|搞一下|研究一下|整一下|看看这个|看下这个)/;

function normalize(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").trim();
}

/** Whether the message merely continues the previous task. */
export function isContinuation(text) {
  return CONTINUATION.test(normalize(text));
}

function countMatches(text, pattern) {
  const found = text.match(pattern);
  return found === null ? 0 : found.length;
}

/**
 * Score one user message.
 *
 * @param {string} text raw message text.
 * @returns {{mode: "simple"|"medium"|"complex"|"ask"|"inherit", reason: string, simple: number, complex: number}}
 */
export function classify(text) {
  const t = normalize(text);
  if (t.length === 0) return { mode: "ask", reason: "empty", simple: 0, complex: 0 };
  if (isContinuation(t)) return { mode: "inherit", reason: "continuation", simple: 0, complex: 0 };
  if (VAGUE.test(t) && [...t].length < 24) return { mode: "ask", reason: "vague", simple: 0, complex: 0 };

  const len = [...t].length;
  const lines = t.split("\n");
  let simple = 0;
  let complex = 0;

  if (GREETING.test(t) && len < 40) {
    return { mode: "simple", reason: "greeting", simple: 3, complex: 0 };
  }
  if (countMatches(t, SIMPLE_VERBS) > 0 && len < 40 && countMatches(t, COMPLEX_VERBS) === 0) {
    return { mode: "simple", reason: "short-factual", simple: 3, complex: 0 };
  }
  if (len <= 8) return { mode: "medium", reason: "tiny-unclear", simple: 1, complex: 0 };

  if (len < 60) simple += 2;
  else if (len < 160) simple += 1;

  if (len > 320) complex += 1;
  if (len > 700) complex += 2;
  if (lines.length > 2) complex += 1;

  if (FENCE_HINT.test(t)) complex += 2;
  if (PATH_HINT.test(t)) complex += 1;
  if (URL_HINT.test(t)) complex += 1;

  const bullets = lines.filter((line) => /^\s*(?:[-*•]|\d+[.)、])\s+/.test(line)).length;
  if (bullets >= 2) complex += 1;

  complex += Math.min(countMatches(t, COMPLEX_VERBS), 3);
  if (/然后|接着|再|并且|同时|之后|最后|分别/.test(t)) complex += 1;
  if (MULTI_PART.test(t)) complex += 1;

  if (countMatches(t, SIMPLE_VERBS) > 0) simple += 1;
  if (len < 40 && /[？?]\s*$/.test(t)) simple += 1;
  if (/简单|快速|一句话|简短|大概|粗略/.test(t)) simple += 1;

  if (complex >= 2 || (len > 400 && complex >= 1)) {
    return { mode: "complex", reason: "leaning-complex", simple, complex };
  }
  if (complex === 1) {
    if (simple >= 3) return { mode: "medium", reason: "single-task-mixed", simple, complex };
    if (simple >= 2) return { mode: "ask", reason: "mixed", simple, complex };
    if (len > 300) return { mode: "complex", reason: "long-single-task", simple, complex };
    return { mode: "medium", reason: "moderate", simple, complex };
  }
  if (simple >= 2) return { mode: "simple", reason: "leaning-simple", simple, complex };
  if (len >= 80) return { mode: "medium", reason: "default-length", simple, complex };
  return { mode: "ask", reason: "uncertain", simple, complex };
}
