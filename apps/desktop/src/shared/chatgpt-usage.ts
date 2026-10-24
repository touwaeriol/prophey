/**
 * ChatGPT plan usage (5-hour / weekly windows) as OpenAI's ChatGPT backend reports it.
 *
 * Shared because the main process fetches and parses the payload and the settings page formats the
 * same numbers; both must agree on units (percent used, seconds of window, epoch ms of reset).
 * `main/chatgpt-usage.ts` explains why only Codex credentials can ask for this payload.
 */

/** Where the user reviews and manages their plan / per-app limit. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

/** A Codex login can read plan windows; a "Sign in with ChatGPT" credential cannot. */
export type ChatGptUsageSource = "openai-codex" | "codex-cli";

export interface ChatGptUsageWindow {
  /** Percent of the window already spent, 0-100. */
  usedPercent: number;
  /** What the UI shows: `100 - usedPercent`, so "8% used" reads "92% 剩余". */
  remainingPercent: number;
  /** Rolling window length the provider reports (18000 = 5 h, 604800 = 7 d). */
  windowSeconds: number;
  /** Epoch ms of the reset, when the payload carried one. */
  resetsAt?: number;
}

export interface ChatGptUsage {
  planType?: string;
  /** Shortest window first, so "5 小时" precedes "7 天". */
  windows: ChatGptUsageWindow[];
  limitReached: boolean;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: number };
  /** Banked on-demand resets. */
  resetCredits?: number;
  source: ChatGptUsageSource;
  fetchedAt: number;
}

export interface ChatGptUsageResult {
  usage?: ChatGptUsage;
  /** Why there is no number; the UI offers the ChatGPT usage link instead. */
  reason?: string;
}

const SOURCE_LABELS: Record<ChatGptUsageSource, string> = {
  "openai-codex": "本应用的 Codex 登录",
  "codex-cli": "本机 Codex CLI 登录",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function parseWindow(
  raw: unknown,
  now: number,
): ChatGptUsageWindow | undefined {
  const window = asRecord(raw);
  if (!window) return undefined;
  const used = asNumber(window.used_percent);
  const seconds = asNumber(window.limit_window_seconds);
  if (used === undefined || seconds === undefined || seconds <= 0) return undefined;

  const resetAt = asNumber(window.reset_at);
  const resetIn = asNumber(window.reset_after_seconds);
  const resetsAt =
    resetAt !== undefined && resetAt > 0
      ? resetAt * 1000
      : resetIn !== undefined && resetIn > 0
        ? now + resetIn * 1000
        : undefined;

  const usedPercent = clampPercent(used);
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    windowSeconds: seconds,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

/**
 * Read a `GET /backend-api/wham/usage` payload.
 *
 * Unknown fields are ignored on purpose: OpenAI ships this endpoint undocumented, so a missing
 * window has to degrade to "no number" instead of throwing in the settings page.
 */
export function parseChatGptUsage(
  payload: unknown,
  options: { source: ChatGptUsageSource; fetchedAt?: number; now?: number },
): ChatGptUsage | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const fetchedAt = options.fetchedAt ?? Date.now();
  const rateLimit = asRecord(root.rate_limit);

  const windows = [rateLimit?.primary_window, rateLimit?.secondary_window]
    .map((raw) => parseWindow(raw, fetchedAt))
    .filter((window): window is ChatGptUsageWindow => window !== undefined)
    .sort((a, b) => a.windowSeconds - b.windowSeconds);

  const creditsRaw = asRecord(root.credits);
  const balanceRaw = creditsRaw?.balance;
  const balance =
    typeof balanceRaw === "number"
      ? balanceRaw
      : typeof balanceRaw === "string" && balanceRaw.trim() !== ""
        ? Number(balanceRaw)
        : undefined;

  const planType = typeof root.plan_type === "string" ? root.plan_type : undefined;
  if (windows.length === 0 && !planType && !creditsRaw) return undefined;

  const resetCredits = asNumber(asRecord(root.rate_limit_reset_credits)?.available_count);

  return {
    ...(planType ? { planType } : {}),
    windows,
    limitReached:
      asBoolean(rateLimit?.limit_reached) === true || asBoolean(rateLimit?.allowed) === false,
    ...(creditsRaw
      ? {
          credits: {
            hasCredits: asBoolean(creditsRaw.has_credits) === true,
            unlimited: asBoolean(creditsRaw.unlimited) === true,
            ...(balance !== undefined && Number.isFinite(balance) ? { balance } : {}),
          },
        }
      : {}),
    ...(resetCredits !== undefined ? { resetCredits } : {}),
    source: options.source,
    fetchedAt,
  };
}

const HOUR = 3600;
const DAY = 86_400;

/** 18000 → "5 小时", 604800 → "7 天"; anything unusual falls back to the raw length. */
export function usageWindowLabel(windowSeconds: number): string {
  if (windowSeconds % DAY === 0) return `${windowSeconds / DAY} 天`;
  if (windowSeconds % HOUR === 0) return `${windowSeconds / HOUR} 小时`;
  return `${Math.max(1, Math.round(windowSeconds / 60))} 分钟`;
}

function formatTime(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function formatCountdown(epochMs: number, now: number): string {
  const minutes = Math.round((epochMs - now) / 60_000);
  if (minutes <= 0) return "即将重置";
  if (minutes < 60) return `${minutes} 分钟后重置`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时后重置`;
  return `${Math.round(hours / 24)} 天后重置`;
}

/** "剩余 92%（5 小时）｜84%（7 天）" — the one-line summary shown next to the provider. */
export function usageWindowsSummary(usage: ChatGptUsage): string {
  return usage.windows
    .map(
      (window, index) =>
        `${index === 0 ? "剩余 " : ""}${Math.floor(window.remainingPercent)}%（${usageWindowLabel(
          window.windowSeconds,
        )}）`,
    )
    .join("｜");
}

/** Tooltip: used percent, reset and where the number came from. */
export function usageTooltip(usage: ChatGptUsage, now = Date.now()): string {
  const parts: string[] = [];
  if (usage.planType) parts.push(`ChatGPT ${usage.planType.toUpperCase()}`);
  if (usage.limitReached) parts.push("已达到用量上限");
  for (const window of usage.windows) {
    const label = usageWindowLabel(window.windowSeconds);
    const reset =
      window.resetsAt === undefined
        ? ""
        : `，${formatCountdown(window.resetsAt, now)}（${formatTime(window.resetsAt)}）`;
    parts.push(`${label}窗口已用 ${Math.round(window.usedPercent)}%${reset}`);
  }
  if (usage.credits && !usage.credits.unlimited && usage.credits.balance !== undefined) {
    parts.push(`余额 ${usage.credits.balance}`);
  }
  if (usage.resetCredits) parts.push(`可重置 ${usage.resetCredits} 次`);
  parts.push(`来源：${SOURCE_LABELS[usage.source]}`);
  parts.push("OpenAI 未向 “Sign in with ChatGPT” 凭据开放用量查询，数字取自 Codex 登录的同一套餐窗口");
  return parts.join(" · ");
}
