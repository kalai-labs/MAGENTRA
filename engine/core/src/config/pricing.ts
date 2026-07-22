import type { Usage } from "@magentra/protocol";
import type { Settings } from "./settings.js";

/**
 * Token pricing, in US dollars per 1,000,000 tokens. The four token classes bill
 * at DIFFERENT rates, so all four are modelled separately — collapsing them (the
 * usual "in/out" shortcut) misprices any cached conversation badly: a cache read
 * is typically ~10x cheaper than a fresh input token, while a cache write costs
 * MORE than one.
 *
 * `cacheRead`/`cacheWrite` default to the `input` rate when a provider does not
 * price them separately, so a table entry may state only what it charges.
 */
export interface ModelPricing {
  input: number;
  output: number;
  /** Cached-prompt read rate; defaults to `input`. */
  cacheRead?: number;
  /** Cache-creation rate; defaults to `input` (Anthropic bills 1.25x input). */
  cacheWrite?: number;
}

/**
 * Built-in rate card ($/1M tokens). A model absent from this table simply has no
 * cost estimate — counts are still reported. Users can add or override entries
 * with `/settings pricing.<model>.input <rate>` (see {@link pricingFor}).
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "deepseek-ai/DeepSeek-V4-Flash": { input: 0.09, output: 0.18, cacheRead: 0.018 },
  "deepseek-ai/DeepSeek-V3.2": { input: 0.26, output: 0.38, cacheRead: 0.13 },
  "openai/gpt-oss-120b": { input: 0.039, output: 0.17 },
  "Qwen/Qwen3-14B": { input: 0.12, output: 0.24 },
  "Qwen/Qwen3.6-35B-A3B": { input: 0.15, output: 0.95 },
  "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo": { input: 0.3, output: 1.0, cacheRead: 0.1 },
  "google/gemma-4-26B-A4B-it": { input: 0.07, output: 0.34 },
  "google/gemma-4-31B-it": { input: 0.13, output: 0.38 },
  "MiniMaxAI/MiniMax-M2.5": { input: 0.15, output: 1.15, cacheRead: 0.03 },
  "XiaomiMiMo/MiMo-V2.5": { input: 0.4, output: 2.0, cacheRead: 0.08 },
  "zai-org/GLM-5": { input: 0.6, output: 2.08, cacheRead: 0.12 },
  "moonshotai/Kimi-K2.5": { input: 0.45, output: 2.25, cacheRead: 0.07 },
};

/**
 * The rate card for `model`: the user's `settings.pricing` entry when present
 * (it wins, so a self-hosted or newly-released model can be priced without a
 * code change), else the built-in table, else undefined — meaning "counts only,
 * no cost estimate", never a guessed price.
 */
export function pricingFor(model: string, settings?: Settings): ModelPricing | undefined {
  return settings?.pricing?.[model] ?? MODEL_PRICING[model];
}

/**
 * Known context-window sizes (tokens), matched by substring of the model id so
 * dated/suffixed variants resolve too. Deliberately conservative where a
 * family ships multiple window sizes.
 */
const MODEL_CONTEXT_WINDOWS: [pattern: string, tokens: number][] = [

];

/**
 * The context window compaction should plan around: an explicit
 * `settings.contextWindow` always wins (local models and odd endpoints), else
 * the known size for this model, else a conservative 128k.
 */
export function contextWindowFor(model: string, settings?: Settings): number {
  if (settings?.contextWindow !== undefined) return settings.contextWindow;
  for (const [pattern, tokens] of MODEL_CONTEXT_WINDOWS) {
    if (model.toLowerCase().includes(pattern.toLowerCase())) return tokens;
  }
  return 128_000;
}

/**
 * Dollar cost of `usage` at `pricing`, billing each of the four token classes at
 * its own rate. Returns undefined when the model has no rate card, so callers
 * can print counts without inventing a number.
 */
export function estimateCost(usage: Usage, pricing: ModelPricing | undefined): number | undefined {
  if (!pricing) return undefined;
  const perToken = (ratePerMillion: number): number => ratePerMillion / 1_000_000;
  return (
    usage.inputTokens * perToken(pricing.input) +
    usage.outputTokens * perToken(pricing.output) +
    usage.cacheReadTokens * perToken(pricing.cacheRead ?? pricing.input) +
    usage.cacheWriteTokens * perToken(pricing.cacheWrite ?? pricing.input)
  );
}

/** "$5.92" / "$0.0008" — cents-precision for real money, 4dp for sub-cent runs. */
export function formatUsd(dollars: number): string {
  if (dollars === 0) return "$0.00";
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(2)}`;
}

/** "12.3k" — compact token counts for status lines. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * One turn's billed tokens, all four classes, with the cost when the model is
 * priced: "1.2k in · 40.2k cache read · 300 out ($0.0041)".
 *
 * Cache classes are shown, not folded away: in a cached conversation they carry
 * most of the tokens (and most of the bill), so an "in/out only" line understates
 * real spend by an order of magnitude.
 */
export function formatTurnUsage(usage: Usage, model?: string, settings?: Settings): string {
  const parts = [`${formatTokens(usage.inputTokens)} in`];
  if (usage.cacheReadTokens > 0) parts.push(`${formatTokens(usage.cacheReadTokens)} cache read`);
  if (usage.cacheWriteTokens > 0) parts.push(`${formatTokens(usage.cacheWriteTokens)} cache write`);
  parts.push(`${formatTokens(usage.outputTokens)} out`);
  const cost = model === undefined ? undefined : estimateCost(usage, pricingFor(model, settings));
  return `${parts.join(" · ")}${cost === undefined ? "" : ` (${formatUsd(cost)})`}`;
}

/** "18m 36s" / "45s" — durations in the session summary. */
export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
