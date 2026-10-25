import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  McpEngineId,
  McpEngineState,
  McpState,
  McpToolInfo,
  McpWebState,
  WebSearchMode,
} from "@shared/types";
import type { EngineId } from "@shared/engine";
import { engineLabel } from "@shared/engine";
import {
  checkWarpgrepEndpoint,
  WARP_DEFAULT_MODEL,
  WARP_ENDPOINT_EXAMPLE,
  WARP_MORPH_MODEL,
} from "@shared/warpgrep-endpoint";
import {
  mcpAvailability,
  mcpUsageLabel,
  type McpGroupId,
  type McpSupportState,
} from "@shared/mcp-support";
import {
  ChevronIcon,
  CloseIcon,
  FolderIcon,
  PlusIcon,
  PlugIcon,
  RefreshIcon,
  TrashIcon,
} from "./Icons";
import { Toggle } from "./Toggle";
import { runAction } from "../lib/actions";

const TEMPLATE_STDIO = `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  "description": "本地文件系统工具"
}`;

const TEMPLATE_HTTP = `{
  "url": "https://example.com/mcp",
  "headers": { "Authorization": "Bearer \${TOKEN}" },
  "description": "远程 MCP 服务"
}`;

const INSTALL_HINTS: Record<McpEngineId, string> = {
  codegraph: "npm i -g @colbymchenry/codegraph",
  warpgrep: "在 Morph 控制台创建 API Key 后粘贴到下方",
  web: "在 Brave Search API 控制台创建订阅令牌后粘贴到下方",
};

const ENGINE_LABELS: Record<string, string> = {
  codegraph: "CodeGraph",
  warpgrep: "WarpGrep",
  web: "网络搜索",
};

const SUPPORT_MARK: Record<McpSupportState, string> = {
  supported: "✓",
  native: "⚠",
  unsupported: "✕",
};

const SUPPORT_TEXT: Record<McpSupportState, string> = {
  supported: "可用",
  native: "走原生",
  unsupported: "不适用",
};

function SupportList({ group }: { group: McpGroupId }): React.JSX.Element {
  return (
    <ul className="mcp-support">
      {mcpAvailability(group).map((entry) => (
        <li key={entry.engine} className={"mcp-support-row " + entry.state}>
          <span className="mcp-support-mark" aria-hidden>
            {SUPPORT_MARK[entry.state]}
          </span>
          <strong>{engineLabel(entry.engine as EngineId)}</strong>
          <em>{SUPPORT_TEXT[entry.state]}</em>
          <span className="mcp-support-note">{entry.note}</span>
        </li>
      ))}
    </ul>
  );
}

function ServiceRow({
  server,
  title,
  description,
  status,
  warning,
  enabled,
  disabled,
  busy,
  group,
  current,
  tools,
  details,
  onToggle,
  onToggleTool,
}: {
  server: string;
  title: string;
  description: string;
  status?: string;
  warning?: string;
  enabled: boolean;
  disabled: boolean;
  busy: boolean;
  /** Which availability table to show for this service. */
  group: McpGroupId;
  /** Engine of the open session, used to mark “not applicable to this engine”. */
  current?: EngineId;
  tools: McpToolInfo[];
  details: ReactNode;
  onToggle: (enabled: boolean) => void;
  onToggleTool: (server: string, tool: string, enabled: boolean) => void;
}): React.JSX.Element {
  const [view, setView] = useState<"config" | "tools" | "engine">();
  const toggleView = (next: "config" | "tools" | "engine"): void =>
    setView(view === next ? undefined : next);
  const usage = mcpUsageLabel(group);
  const here = mcpAvailability(group).find((entry) => entry.engine === current);
  const elsewhere = here && here.state === "unsupported";
  return (
    <div
      className={
        "mcp-service " +
        (enabled ? "" : "disabled") +
        (elsewhere ? " inapplicable" : "")
      }
    >
      <div className="mcp-service-row">
        <span className="mcp-service-icon">
          <PlugIcon size={15} />
        </span>
        <div className="mcp-row-main">
          <div className="mcp-row-title">
            <strong>{title}</strong>
            {status && (
              <span className="mcp-service-status" title={status}>
                {status}
              </span>
            )}
            <span
              className={"mcp-usage" + (elsewhere ? " off" : "")}
              title={here ? usage + " — " + here.note : usage}
            >
              {usage}
            </span>
          </div>
          <span className="mcp-row-sub" title={description}>
            {elsewhere && current
              ? `当前引擎 ${engineLabel(current)} 不使用这个服务 — ${description}`
              : description}
          </span>
        </div>
        <div className="mcp-service-actions">
          <button
            className={"ghost " + (view === "engine" ? "active" : "")}
            aria-label={title + "适用引擎"}
            aria-expanded={view === "engine"}
            title="按引擎查看是否适用"
            onClick={() => toggleView("engine")}
          >
            适用引擎 <ChevronIcon size={10} />
          </button>
          <button
            className={"ghost " + (view === "tools" ? "active" : "")}
            aria-label={title + "工具"}
            aria-expanded={view === "tools"}
            onClick={() => toggleView("tools")}
          >
            {tools.length} 个工具
          </button>
          <button
            className={"ghost " + (view === "config" ? "active" : "")}
            aria-label={title + "配置"}
            aria-expanded={view === "config"}
            onClick={() => toggleView("config")}
          >
            配置 <ChevronIcon size={10} />
          </button>
          <Toggle checked={enabled} disabled={disabled} onChange={onToggle} />
        </div>
      </div>
      {warning && (
        <div className="mcp-service-warning" title={warning}>
          {warning}
        </div>
      )}
      {view === "engine" && (
        <div className="mcp-service-detail">
          <SupportList group={group} />
          <p className="field-hint mcp-support-foot">
            ✓ 直接生效（工具名可能随引擎不同）· ⚠
            引擎用自己的原生工具，不注入这个 MCP · ✕
            该引擎不接入。标记只做说明，开关键仍按桌面配置保存。
          </p>
        </div>
      )}
      {view === "config" && <div className="mcp-service-detail">{details}</div>}
      {view === "tools" && (
        <div className="mcp-service-detail">
          {tools.length === 0 ? (
            <p className="field-hint">连接后会显示可用工具。</p>
          ) : (
            <div className="mcp-tools">
              {tools.map((tool) => (
                <label
                  key={tool.name}
                  className={"mcp-tool " + (tool.enabled ? "" : "off")}
                >
                  <Toggle
                    checked={tool.enabled}
                    disabled={busy}
                    onChange={(value) => onToggleTool(server, tool.name, value)}
                  />
                  <code title={tool.name}>{tool.name}</code>
                  <span className="badge">
                    {tool.enabled
                      ? tool.direct || tool.exposure === "direct"
                        ? "直接声明"
                        : "按需加载"
                      : "已关闭"}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EngineCard({
  engine,
  busy,
  current,
  morphKeyHint,
  warpgrep,
  web,
  onToggle,
  onPickEntry,
  onClearEntry,
  onBuildIndex,
  onSaveKey,
  onSaveWarpgrep,
  onSaveBraveKey,
  onSetWebMode,
  onToggleTool,
}: {
  engine: McpEngineState;
  busy: boolean;
  /** Engine of the open session, so the row can say when it does not apply. */
  current?: EngineId;
  morphKeyHint?: string;
  warpgrep?: McpState["warpgrep"];
  web?: McpWebState;
  onToggle: (id: McpEngineId, enabled: boolean) => void;
  onPickEntry: (id: McpEngineId) => void;
  onClearEntry: (id: McpEngineId) => void;
  onBuildIndex: () => void;
  onSaveKey: (key: string | null) => void;
  onSaveWarpgrep: (patch: {
    baseUrl?: string | null;
    model?: string | null;
    apiKey?: string | null;
  }) => void;
  onSaveBraveKey: (key: string | null) => void;
  onSetWebMode: (mode: WebSearchMode) => void;
  onToggleTool: (server: string, tool: string, enabled: boolean) => void;
}): React.JSX.Element {
  const [keyDraft, setKeyDraft] = useState("");
  const [endpointDraft, setEndpointDraft] = useState(warpgrep?.baseUrl ?? "");
  const [modelDraft, setModelDraft] = useState(warpgrep?.model ?? "");
  const [braveDraft, setBraveDraft] = useState("");
  // The saved backend arrives after the first paint (and changes after every save), so the fields
  // follow it: they show what is in use and are edited in place, never "type it again to replace".
  useEffect(() => {
    setEndpointDraft(warpgrep?.baseUrl ?? "");
    setModelDraft(warpgrep?.model ?? "");
  }, [warpgrep?.baseUrl, warpgrep?.model]);
  const indexLabel: Record<string, string> = {
    indexed: "已索引",
    missing: "未建立索引",
    indexing: "正在建立索引…",
    syncing: "正在同步索引…",
    failed: "索引失败",
    unknown: "索引状态未知",
  };
  const isWarpGrep = engine.id === "warpgrep";
  const isWeb = engine.id === "web";
  const webHint = web?.braveKeyHint;
  const endpointCheck = checkWarpgrepEndpoint(endpointDraft);
  const endpointDirty =
    (endpointCheck.baseUrl ?? "") !== (warpgrep?.baseUrl ?? "") ||
    modelDraft.trim() !== (warpgrep?.model ?? "");
  const activeKey = warpgrep?.activeKey;
  const keySourceLabel = !activeKey
    ? undefined
    : activeKey.source === "provider"
      ? `复用「${activeKey.provider ?? "服务商"}」已登录的 Key`
      : activeKey.source === "own"
        ? "此端点单独保存的 Key"
        : "Morph 的 Key";
  const description = isWeb
    ? "搜索网页与读取网页内容"
    : isWarpGrep
      ? "用自然语言搜索项目代码"
      : "代码索引、符号搜索与调用关系";
  const status = !engine.available
    ? isWarpGrep || isWeb
      ? "待配置"
      : "未安装"
    : !engine.enabled
      ? "已关闭"
      : isWeb
        ? web?.route
        : isWarpGrep
          ? "已配置"
          : indexLabel[engine.index ?? "unknown"];
  return (
    <ServiceRow
      server={engine.id}
      title={engine.name}
      description={description}
      status={status}
      group={engine.id}
      current={current}
      warning={engine.error}
      enabled={engine.enabled}
      disabled={busy || !engine.available}
      busy={busy}
      tools={engine.tools}
      onToggle={(value) => onToggle(engine.id, value)}
      onToggleTool={onToggleTool}
      details={
        <>
          {!isWarpGrep && !isWeb && (
            <p className="field-hint mcp-config-path">
              {engine.version && (
                <span>版本 {engine.version.replace(/^v/i, "")} · </span>
              )}
              <code>{engine.entry ?? "未找到入口"}</code>
              {engine.indexMessage && <span> · {engine.indexMessage}</span>}
            </p>
          )}
          {isWarpGrep && (
            <p className="field-hint">
              搜索时读取的代码片段会发到下面的后端。自定义端点要填 OpenAI 兼容的 chat
              completions 基础地址（如 <code>{WARP_ENDPOINT_EXAMPLE}</code>），结尾不要带{" "}
              <code>/chat/completions</code>，也不能用 Anthropic 的 <code>/anthropic</code>。
              留空则用 Morph 托管模型。
            </p>
          )}
          {isWeb && web && (
            <p className="field-hint">
              每次搜索 {web.count} 条结果 · 网页最多读取 {web.maxChars} 字符
            </p>
          )}
          {!engine.available && (
            <div className="mcp-install">
              <span>
                {isWeb
                  ? "web_search 还没有后端：填一个 Brave Search API Key，或到 设置 → 服务商 给某个服务商打开「联网」。"
                  : isWarpGrep
                    ? "未配置 Morph API Key。"
                    : "未找到 CodeGraph。安装："}
              </span>
              {!isWarpGrep && !isWeb && (
                <>
                  <code>{INSTALL_HINTS.codegraph}</code>
                  <button
                    className="ghost"
                    onClick={() =>
                      void navigator.clipboard?.writeText(
                        INSTALL_HINTS.codegraph,
                      )
                    }
                  >
                    复制
                  </button>
                  <span className="mcp-install-alt">
                    已装在别处？用「选择入口」指定可执行文件（CodeGraph 的{" "}
                    <code>npm-shim.js</code>）。
                  </span>
                </>
              )}
              {isWeb && (
                <span className="mcp-install-alt">
                  web_fetch 不需要 Key，只用 Brave
                  时需要；服务商原生搜索沿用该服务商已登录的凭据。
                </span>
              )}
            </div>
          )}
          {isWeb ? (
            <>
              <div className="mcp-web-mode">
                <span className="mcp-web-label">搜索来源</span>
                <div className="mcp-seg">
                  {(
                    [
                      ["auto", "自动"],
                      ["brave", "仅 Brave"],
                      ["native", "仅服务商"],
                    ] as Array<[WebSearchMode, string]>
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      className={(web?.mode ?? "auto") === mode ? "active" : ""}
                      disabled={busy || !engine.enabled}
                      onClick={() => onSetWebMode(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="mcp-web-note">
                  自动：当前服务商开了「联网」就用它的原生搜索，否则用 Brave。
                </span>
              </div>
              <div className="mcp-key-row">
                <input
                  type="password"
                  value={braveDraft}
                  placeholder={
                    webHint
                      ? `已保存 ${webHint}，输入新 Key 覆盖`
                      : "Brave Search API Key"
                  }
                  onChange={(event) => setBraveDraft(event.target.value)}
                  spellCheck={false}
                />
                <button
                  className="ghost"
                  disabled={busy || !braveDraft.trim()}
                  onClick={() => {
                    onSaveBraveKey(braveDraft.trim());
                    setBraveDraft("");
                  }}
                >
                  保存 Key
                </button>
                {webHint && (
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => onSaveBraveKey(null)}
                  >
                    清除
                  </button>
                )}
              </div>
            </>
          ) : isWarpGrep ? (
            <>
              <div className="mcp-key-row mcp-endpoint-row">
                <input
                  value={endpointDraft}
                  placeholder={`OpenAI 兼容地址，如 ${WARP_ENDPOINT_EXAMPLE}`}
                  onChange={(event) => setEndpointDraft(event.target.value)}
                  spellCheck={false}
                />
                <input
                  value={modelDraft}
                  placeholder={`模型，默认 ${WARP_DEFAULT_MODEL}`}
                  onChange={(event) => setModelDraft(event.target.value)}
                  spellCheck={false}
                />
                <button
                  className="ghost"
                  disabled={busy || !!endpointCheck.error || !endpointDirty}
                  onClick={() => {
                    onSaveWarpgrep({
                      baseUrl: endpointCheck.baseUrl ?? null,
                      model: modelDraft.trim() || null,
                    });
                  }}
                >
                  保存端点
                </button>
                {warpgrep?.baseUrl && (
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => onSaveWarpgrep({ baseUrl: null, model: null })}
                  >
                    用回 Morph
                  </button>
                )}
              </div>
              {(endpointCheck.error || endpointCheck.normalized) && (
                <p
                  className={`field-hint${endpointCheck.error ? " mcp-field-error" : ""}`}
                >
                  {endpointCheck.error ?? `保存时记为 ${endpointCheck.baseUrl}`}
                </p>
              )}
              <div className="mcp-key-row">
                <input
                  type="password"
                  value={keyDraft}
                  placeholder={
                    activeKey
                      ? `输入新 Key 覆盖当前 ${activeKey.hint}`
                      : warpgrep?.baseUrl
                        ? "sk-...（这个端点还没有 Key）"
                        : "sk-w_...（Morph API Key）"
                  }
                  onChange={(event) => setKeyDraft(event.target.value)}
                  spellCheck={false}
                />
                <button
                  className="ghost"
                  disabled={busy || !keyDraft.trim()}
                  onClick={() => {
                    if (warpgrep?.baseUrl) onSaveWarpgrep({ apiKey: keyDraft.trim() });
                    else onSaveKey(keyDraft.trim());
                    setKeyDraft("");
                  }}
                >
                  保存 Key
                </button>
                {(warpgrep?.keyHint || morphKeyHint) && (
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => {
                      if (warpgrep?.keyHint) onSaveWarpgrep({ apiKey: null });
                      else onSaveKey(null);
                    }}
                  >
                    清除
                  </button>
                )}
              </div>
              <p className="field-hint mcp-warpgrep-summary">
                当前：{warpgrep?.baseUrl ?? "Morph 托管模型"}
                {" · "}
                {warpgrep?.baseUrl
                  ? warpgrep.model ?? WARP_DEFAULT_MODEL
                  : WARP_MORPH_MODEL}
                {" · "}
                {keySourceLabel ?? "还没有可用的 Key"}
                {activeKey ? `（${activeKey.hint}）` : ""}
              </p>
            </>
          ) : (
            <div className="mcp-engine-actions">
              <button
                className="ghost"
                disabled={busy}
                onClick={() => onPickEntry(engine.id)}
              >
                选择入口
              </button>
              {engine.entry && (
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() => onClearEntry(engine.id)}
                >
                  恢复自动检测
                </button>
              )}
              <button
                className="ghost"
                disabled={busy || !engine.available}
                onClick={onBuildIndex}
              >
                立即索引
              </button>
            </div>
          )}
        </>
      }
    />
  );
}

export function McpPanel({
  onNotice,
  onError,
}: {
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [state, setState] = useState<McpState>();
  /** Engine of the open session: the page talks about MCP for *this* engine. */
  const [current, setCurrent] = useState<EngineId>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [json, setJson] = useState(TEMPLATE_STDIO);
  const [confirmRemove, setConfirmRemove] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setState(await window.pi.getMcpState());
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
    return window.pi.onMcpState((next) => setState(next));
  }, [load]);

  useEffect(() => {
    void window.pi
      .getStatus()
      .then((status) => setCurrent(status.engine ?? "prophey"));
    return window.pi.onStatus((status) =>
      setCurrent(status.engine ?? "prophey"),
    );
  }, []);

  const run = useCallback(
    async (
      task: () => Promise<McpState | { ok: boolean; error?: string } | void>,
      message?: string,
    ) => {
      return runAction(task, {
        setBusy,
        onError,
        onSuccess: async () => {
          setState(await window.pi.getMcpState());
          if (message) onNotice(message);
        },
      });
    },
    [onError, onNotice],
  );

  const remove = useCallback(
    (serverName: string) => {
      if (confirmRemove !== serverName) {
        setConfirmRemove(serverName);
        setTimeout(
          () =>
            setConfirmRemove((value) =>
              value === serverName ? undefined : value,
            ),
          4000,
        );
        return;
      }
      setConfirmRemove(undefined);
      void run(
        () => window.pi.removeMcpServer(serverName),
        `已删除 ${serverName}`,
      );
    },
    [confirmRemove, run],
  );

  const submit = useCallback(() => {
    if (!name.trim()) {
      onError("请填写服务器名称");
      return;
    }
    void run(
      () => window.pi.addMcpServer(name.trim(), json),
      `已添加 ${name.trim()}`,
    ).then((ok) => {
      if (!ok) return;
      setAddOpen(false);
      setName("");
      setJson(TEMPLATE_STDIO);
    });
  }, [json, name, onError, run]);

  const toggleTool = useCallback(
    (server: string, tool: string, enabled: boolean) => {
      void run(() => window.pi.setMcpToolEnabled(server, tool, enabled));
    },
    [run],
  );

  const pickEntry = useCallback(
    (id: McpEngineId) => {
      void (async () => {
        const selected = await window.pi.chooseMcpEngineEntry();
        if (!selected) return;
        await run(
          () => window.pi.setMcpEngineEntry(id, selected),
          "入口已更新",
        );
      })();
    },
    [run],
  );

  const saveKey = useCallback(
    (key: string | null) => {
      void run(
        () => window.pi.setMorphApiKey(key),
        key ? "Morph API Key 已保存" : "已清除 Morph API Key",
      );
    },
    [run],
  );

  const saveWarpgrep = useCallback(
    (patch: { baseUrl?: string | null; model?: string | null; apiKey?: string | null }) => {
      void run(
        () => window.pi.setWarpgrepBackend(patch),
        "baseUrl" in patch && !patch.baseUrl
          ? "已恢复使用 Morph"
          : "WarpGrep 端点已更新",
      );
    },
    [run],
  );

  const saveBraveKey = useCallback(
    (key: string | null) => {
      void run(
        () => window.pi.setBraveApiKey(key),
        key ? "Brave Search Key 已保存" : "已清除 Brave Search Key",
      );
    },
    [run],
  );

  const setWebMode = useCallback(
    (mode: WebSearchMode) => {
      const labels: Record<WebSearchMode, string> = {
        auto: "搜索来源：自动（服务商优先，否则 Brave）",
        brave: "搜索来源：仅 Brave",
        native: "搜索来源：仅服务商原生",
      };
      void run(() => window.pi.setWebSearchMode(mode), labels[mode]);
    },
    [run],
  );

  const servers = state?.servers.filter((server) => !server.builtin) ?? [];
  return (
    <div className="settings-content mcp">
      <div className="mcp-toolbar">
        <div className="mcp-master">
          <Toggle
            checked={state?.enabled ?? true}
            disabled={busy || loading}
            onChange={(value) =>
              void run(
                () => window.pi.setMcpEnabled(value),
                value ? "MCP 已启用" : "MCP 已关闭",
              )
            }
          />
          <strong>MCP {state?.enabled === false ? "已关闭" : "已启用"}</strong>
          <span className="mcp-toolbar-hint">管理当前引擎使用的工具服务</span>
        </div>
        <button
          className="icon-btn"
          title="刷新服务状态"
          disabled={busy || loading}
          onClick={() => void run(() => window.pi.refreshMcpEngines())}
        >
          <RefreshIcon size={13} />
        </button>
      </div>
      {state?.enabled === false && (
        <p className="field-hint">MCP 已暂停，配置会保留，重新启用后生效。</p>
      )}
      <div className="mcp-group">
        <div className="mcp-head">
          <label>内置服务</label>
        </div>
        <div className="mcp-service-list">
          <ServiceRow
            server="desktop"
            title="桌面交互"
            description="提问确认、选项选择与桌面协作"
            group="desktop"
            current={current}
            status={
              !state?.desktopToolAvailable
                ? "不可用"
                : state?.desktopTool
                  ? "已启用"
                  : "已关闭"
            }
            warning={
              state && !state.desktopToolAvailable
                ? "缺少服务组件，请重新安装应用。"
                : undefined
            }
            enabled={state?.desktopTool ?? true}
            disabled={busy || loading || !state?.desktopToolAvailable}
            busy={busy}
            tools={state?.desktopTools ?? []}
            onToggleTool={toggleTool}
            onToggle={(value) =>
              void run(
                () => window.pi.setDesktopToolEnabled(value),
                value ? "桌面交互已启用" : "桌面交互已关闭",
              )
            }
            details={
              <p className="field-hint">
                支持单选、多选和文字回答。
                {state?.bridge.running
                  ? "本地连接已就绪（127.0.0.1:" + state.bridge.port + "）。"
                  : "本地连接尚未就绪。"}
                {state?.bridge.pending
                  ? "等待回答 " + state.bridge.pending + " 个问题。"
                  : ""}
              </p>
            }
          />
          {state?.engines.map((engine) => (
            <EngineCard
              key={engine.id}
              engine={engine}
              busy={busy}
              current={current}
              morphKeyHint={state.morphKeyHint}
              warpgrep={state.warpgrep}
              web={state.web}
              onToggle={(id, enabled) =>
                void run(
                  () => window.pi.setMcpEngineEnabled(id, enabled),
                  `${ENGINE_LABELS[id] ?? id}${enabled ? " 已启用" : " 已关闭"}`,
                )
              }
              onPickEntry={pickEntry}
              onClearEntry={(id) =>
                void run(() => window.pi.setMcpEngineEntry(id, null))
              }
              onBuildIndex={() =>
                void run(async () => {
                  const result = await window.pi.buildMcpIndex();
                  if (!result.ok) throw new Error(result.message);
                  onNotice(result.message);
                })
              }
              onSaveKey={saveKey}
              onSaveWarpgrep={saveWarpgrep}
              onSaveBraveKey={saveBraveKey}
              onSetWebMode={setWebMode}
              onToggleTool={toggleTool}
            />
          ))}
          {!state && loading && (
            <div className="provider-empty">正在读取服务…</div>
          )}
        </div>
      </div>

      <div className="mcp-group">
        <div className="mcp-head">
          <label>
            已添加的服务{" "}
            <span className="mcp-group-count">{servers.length}</span>
          </label>
          <div className="mcp-head-actions">
            <button
              className="ghost"
              onClick={() => setAddOpen((value) => !value)}
            >
              <PlusIcon size={12} /> 添加
            </button>
            <button
              className="ghost"
              onClick={() => void window.pi.openMcpConfig("user")}
              title={state?.userConfigPath}
            >
              <FolderIcon size={12} /> 配置文件
            </button>
            <button
              className="icon-btn"
              onClick={() => void load()}
              title="刷新"
            >
              <RefreshIcon size={13} />
            </button>
          </div>
        </div>

        {addOpen && (
          <div className="mcp-add">
            <div className="mcp-add-row">
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="服务器名称（字母、数字、_、-）"
                spellCheck={false}
              />
              <button
                className="ghost"
                onClick={() => setJson(TEMPLATE_STDIO)}
                title="stdio 模板"
              >
                stdio
              </button>
              <button
                className="ghost"
                onClick={() => setJson(TEMPLATE_HTTP)}
                title="HTTP 模板"
              >
                HTTP
              </button>
            </div>
            <textarea
              value={json}
              onChange={(event) => setJson(event.target.value)}
              rows={7}
              spellCheck={false}
            />
            <div className="mcp-add-actions">
              <button className="ghost" onClick={() => setAddOpen(false)}>
                取消
              </button>
              <button className="primary" onClick={submit} disabled={busy}>
                保存并应用
              </button>
            </div>
          </div>
        )}

        <div className="mcp-list">
          {loading && <div className="provider-empty">正在读取 MCP 配置…</div>}
          {!loading && servers.length === 0 && (
            <div className="provider-empty">添加 MCP 服务，接入更多工具。</div>
          )}
          {servers.map((server) => {
            const here = mcpAvailability("external").find(
              (entry) => entry.engine === current,
            );
            const elsewhere = here?.state === "unsupported";
            return (
              <div
                key={`${server.source}-${server.name}`}
                className={`mcp-server ${server.enabled ? "" : "disabled"}${elsewhere ? " inapplicable" : ""}`}
              >
                <span className="mcp-server-icon">
                  <PlugIcon size={13} />
                </span>
                <div className="mcp-server-main">
                  <div className="mcp-server-name">
                    {server.name}
                    {server.source === "project" && (
                      <span className="badge">项目</span>
                    )}
                    <span
                      className={"mcp-usage" + (elsewhere ? " off" : "")}
                      title={here?.note ?? mcpUsageLabel("external")}
                    >
                      {mcpUsageLabel("external")}
                    </span>
                  </div>
                  <div className="mcp-server-sub">
                    <span className="mcp-transport">{server.transport}</span>
                    <code title={server.summary}>
                      {server.description || server.summary}
                    </code>
                  </div>
                </div>
                <div className="mcp-server-actions">
                  <Toggle
                    checked={server.enabled}
                    disabled={busy}
                    onChange={(value) =>
                      void run(() =>
                        window.pi.setMcpServerEnabled(server.name, value),
                      )
                    }
                  />
                  <button
                    className={`icon-btn ${confirmRemove === server.name ? "danger" : ""}`}
                    title={
                      confirmRemove === server.name
                        ? "再次点击确认删除"
                        : "删除"
                    }
                    onClick={() => remove(server.name)}
                  >
                    {confirmRemove === server.name ? (
                      <CloseIcon size={13} />
                    ) : (
                      <TrashIcon size={13} />
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <details className="mcp-config-files">
          <summary>配置文件位置</summary>
          <p className="field-hint">
            用户配置：<code>{state?.userConfigPath ?? "加载中…"}</code>
          </p>
          <p className="field-hint">
            项目配置：<code>{state?.projectConfigPath ?? "加载中…"}</code>
          </p>
          <p className="field-hint">修改后自动应用；引擎忙碌时可能延后生效。</p>
        </details>
      </div>
    </div>
  );
}
