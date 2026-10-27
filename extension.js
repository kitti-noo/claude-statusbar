// Claude Status Bar: shows Claude plan usage limits (session / weekly) from the
// OAuth usage API, plus model, context and estimated cost from local transcripts.
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { execFile } = require("child_process");

const PROJECTS_DIR = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  "projects"
);

// USD per 1M tokens. Cache write: 5m = 1.25x input, 1h = 2x input.
const PRICING = [
  { match: "fable-5", name: "Fable", input: 10, output: 50, cacheRead: 0.25, context: 1_000_000 },
  { match: "mythos-5", name: "Mythos", input: 10, output: 50, cacheRead: 0.25, context: 1_000_000 },
  { match: "opus-5-5", name: "Opus 5.5", input: 4, output: 20, cacheRead: 0.2, context: 1_000_000 },
  { match: "opus-5", name: "Opus 5", input: 5, output: 25, cacheRead: 0.5, context: 1_000_000 },
  { match: "opus-4", name: "Opus 4", input: 5, output: 25, cacheRead: 0.5, context: 1_000_000 },
  { match: "sonnet-5", name: "Sonnet 5", input: 2, output: 10, cacheRead: 0.2, context: 1_000_000 },
  { match: "sonnet-4", name: "Sonnet 4", input: 3, output: 15, cacheRead: 0.3, context: 1_000_000 },
  { match: "haiku", name: "Haiku", input: 1, output: 5, cacheRead: 0.1, context: 200_000 },
];

function priceFor(model) {
  const m = (model || "").toLowerCase();
  return PRICING.find((p) => m.includes(p.match)) || null;
}

// "claude-sonnet-5-5" -> "Sonnet 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5".
function prettyModel(model) {
  const p = priceFor(model);
  if (!p) return model || "Claude";
  const ver = (model.match(new RegExp(`${p.match.split("-")[0]}-(\\d+(?:-\\d{1,2})?)`)) || [])[1];
  const family = p.name.split(" ")[0];
  return ver ? `${family} ${ver.replace("-", ".")}` : p.name;
}

function messageCost(model, u) {
  const p = priceFor(model);
  if (!p || !u) return 0;
  const c = u.cache_creation || {};
  const write1h = c.ephemeral_1h_input_tokens || 0;
  const write5m = c.ephemeral_5m_input_tokens ?? Math.max((u.cache_creation_input_tokens || 0) - write1h, 0);
  const usd =
    ((u.input_tokens || 0) * p.input +
      (u.output_tokens || 0) * p.output +
      (u.cache_read_input_tokens || 0) * p.cacheRead +
      write5m * p.input * 1.25 +
      write1h * p.input * 2) /
    1_000_000;
  return u.speed === "fast" ? usd * 2 : usd;
}

// Per-file parse cache: path -> { key, messages: Map(id -> {model, cost, ts, usage, sidechain}) }
const fileCache = new Map();

function parseFile(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${st.size}:${st.mtimeMs}`;
  const cached = fileCache.get(file);
  if (cached && cached.key === key) return cached;

  const messages = new Map();
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== "assistant" || !d.message || !d.message.usage) continue;
    const id = d.message.id || d.requestId || d.uuid;
    // Streamed blocks repeat the same message id; keep the last (final usage).
    messages.set(id, {
      model: d.message.model,
      usage: d.message.usage,
      cost: messageCost(d.message.model, d.message.usage),
      ts: d.timestamp ? Date.parse(d.timestamp) : st.mtimeMs,
      sidechain: !!d.isSidechain,
    });
  }
  const entry = { key, mtimeMs: st.mtimeMs, messages };
  fileCache.set(file, entry);
  return entry;
}

function listJsonl(dir, depth = 0) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) out.push(...listJsonl(p, depth + 1));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function projectDirFor(folder) {
  return path.join(PROJECTS_DIR, folder.replace(/[^A-Za-z0-9]/g, "-"));
}

function newestSessionFile() {
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const dirs = folders.map(projectDirFor).filter((d) => fs.existsSync(d));
  const candidates = [];
  const scan = dirs.length
    ? dirs
    : fs.existsSync(PROJECTS_DIR)
    ? fs.readdirSync(PROJECTS_DIR).map((d) => path.join(PROJECTS_DIR, d))
    : [];
  for (const d of scan) {
    let names = [];
    try {
      names = fs.readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const p = path.join(d, n);
      try {
        candidates.push({ p, m: fs.statSync(p).mtimeMs });
      } catch {}
    }
  }
  candidates.sort((a, b) => b.m - a.m);
  return candidates[0] ? candidates[0].p : null;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function collectStats() {
  const sessionFile = newestSessionFile();
  if (!sessionFile) return null;

  // Session = main transcript + its subagent transcripts (<session-id>/**.jsonl).
  const sessionDir = sessionFile.replace(/\.jsonl$/, "");
  const sessionFiles = [sessionFile, ...listJsonl(sessionDir)];
  let sessionCost = 0;
  for (const f of sessionFiles) {
    const e = parseFile(f);
    if (e) for (const m of e.messages.values()) sessionCost += m.cost;
  }

  // Latest main-chain message = current context size and model.
  const main = parseFile(sessionFile);
  let last = null;
  if (main) for (const m of main.messages.values()) if (!m.sidechain && m.model !== "<synthetic>" && (!last || m.ts >= last.ts)) last = m;

  // Today's total across all projects (only files touched today are parsed).
  const today = startOfToday();
  let todayCost = 0;
  for (const f of listJsonl(PROJECTS_DIR)) {
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    if (st.mtimeMs < today) continue;
    const e = parseFile(f);
    if (e) for (const m of e.messages.values()) if (m.ts >= today) todayCost += m.cost;
  }

  const u = (last && last.usage) || {};
  const used =
    (u.input_tokens || 0) +
    (u.cache_read_input_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.output_tokens || 0);
  const p = priceFor(last && last.model);
  const window = p ? p.context : 200_000;
  return {
    model: last ? last.model : null,
    used,
    window,
    sessionCost,
    todayCost,
    sessionId: path.basename(sessionFile, ".jsonl"),
    updated: main ? main.mtimeMs : Date.now(),
  };
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function bar(pct, width) {
  const filled = Math.round((pct / 100) * width);
  return "●".repeat(filled) + "○".repeat(Math.max(width - filled, 0));
}

// --- Plan usage limits (same data as claude.ai Settings > Usage) ---
// The OAuth token is read from Claude Code's own credential store on each fetch,
// kept only in memory, and never logged or written anywhere.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CREDENTIALS_FILE = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  ".credentials.json"
);

// "Max 5x" / "Max 20x" / "Pro" from the credential store's subscriptionType + rateLimitTier.
function planLabel(oauth) {
  const type = String(oauth.subscriptionType || "").toLowerCase();
  if (!type) return "";
  const name = type.charAt(0).toUpperCase() + type.slice(1);
  const mult = type === "max" ? (String(oauth.rateLimitTier || "").match(/(\d+)x/i) || [])[1] : null;
  return mult ? `${name} ${mult}x` : name;
}

function readCredentials() {
  return new Promise((resolve, reject) => {
    const fromJson = (raw) => {
      try {
        const oauth = JSON.parse(raw).claudeAiOauth;
        return oauth?.accessToken
          ? resolve({ token: oauth.accessToken, plan: planLabel(oauth) })
          : reject(new Error("no OAuth token (API key login?)"));
      } catch {
        reject(new Error("cannot parse Claude credentials"));
      }
    };
    if (process.platform === "darwin") {
      execFile(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 10000 },
        (err, stdout) => (err ? reject(new Error("Keychain access denied or item missing")) : fromJson(stdout.trim()))
      );
    } else {
      fs.readFile(CREDENTIALS_FILE, "utf8", (err, raw) =>
        err ? reject(new Error("no ~/.claude/.credentials.json")) : fromJson(raw)
      );
    }
  });
}

// Retry-After is either delta-seconds or an HTTP date; returns ms or 0.
function parseRetryAfter(value) {
  if (!value) return 0;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(secs, 0) * 1000;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : Math.max(t - Date.now(), 0);
}

async function fetchUsage() {
  const { token, plan } = await readCredentials();
  return new Promise((resolve, reject) => {
    const req = https.get(
      USAGE_URL,
      {
        headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
        timeout: 15000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            const err = new Error(`usage API HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.retryAfterMs = parseRetryAfter(res.headers["retry-after"]);
            return reject(err);
          }
          try {
            resolve({ ...JSON.parse(body), plan });
          } catch {
            reject(new Error("usage API returned invalid JSON"));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("usage API timeout")));
    req.on("error", reject);
  });
}

// Absolute date + time, e.g. "Fri 2 Oct 09:33".
function fmtDateTime(t) {
  return new Date(t).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtReset(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins <= 0) return "reset แล้ว";
  if (mins < 60) return `reset ใน ${mins} นาที`;
  if (mins < 24 * 60) return `reset ใน ${Math.floor(mins / 60)} ชม. ${mins % 60} นาที`;
  return `reset ${fmtDateTime(t)}`;
}

// Compact time-until-reset for the status bar text, e.g. "38m", "2h 5m".
function fmtTimeLeft(iso) {
  const t = Date.parse(iso || "");
  if (Number.isNaN(t)) return "";
  const mins = Math.max(Math.ceil((t - Date.now()) / 60000), 0);
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
}

// Monthly spend cap (Enterprise / usage-credit accounts, which have no session/weekly windows).
function spendInfo(usage) {
  const sp = usage && usage.spend;
  if (!sp || !sp.enabled || !sp.limit || !sp.used) return null;
  const div = 10 ** (sp.limit.exponent || 0);
  const limit = sp.limit.amount_minor / div;
  const used = sp.used.amount_minor / div;
  const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  return { used, limit, pct, currency: sp.limit.currency };
}

const fmtMoney = (n) => `$${n.toFixed(n % 1 ? 2 : 0)}`;

function activate(context) {
  // Right items use flex-wrap + row-reverse in a fixed-height bar, so when the bar is full
  // the leftmost (highest priority) items wrap out of view. A low priority keeps this item
  // near the right edge, where it is the last to be pushed out.
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -1000);
  item.command = "claudeStatusbar.refresh";
  context.subscriptions.push(item);

  // Usage state is shared by all VS Code windows through one file in global storage,
  // so only one window hits the usage API per interval and a 429 backs off everywhere.
  // It holds only the usage response and timestamps, never the OAuth token.
  // { usage, at, backoffUntil, backoffCount, fetchingUntil }
  const sharedFile = path.join(context.globalStorageUri.fsPath, "usage-cache.json");
  const readShared = () => {
    try {
      return JSON.parse(fs.readFileSync(sharedFile, "utf8")) || {};
    } catch {
      return {};
    }
  };
  const writeShared = (state) => {
    try {
      fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
      fs.writeFileSync(sharedFile, JSON.stringify(state));
    } catch {
      // Sharing is best effort; this window still works on its own state.
    }
  };

  let shared = readShared();
  let usage = shared.usage || null;
  let usageError = null;
  let usageAt = shared.at || 0;

  const render = () => {
    const cfg = vscode.workspace.getConfiguration("claudeStatusbar");
    const width = cfg.get("barWidth", 10);
    let s = null;
    try {
      s = collectStats();
    } catch (err) {
      usageError = usageError || `transcript: ${err.message}`;
    }

    const five = usage && usage.five_hour;
    const week = usage && usage.seven_day;
    const pct = (w) => Math.min(Math.max(Number(w && w.utilization) || 0, 0), 100);

    const plan = usage && usage.plan;
    const parts = [`$(sparkle) ${s && s.model ? prettyModel(s.model) : "Claude"}${plan ? ` · ${plan}` : ""}`];
    if (five) {
      const left = fmtTimeLeft(five.resets_at);
      parts.push(`Session ${bar(pct(five), width)} ${pct(five).toFixed(0)}%${left ? ` $(clock) ${left}` : ""}`);
    }
    const spend = spendInfo(usage);
    if (spend) parts.push(`Spend ${bar(spend.pct, width)} ${fmtMoney(spend.used)}/${fmtMoney(spend.limit)}`);
    if (!five && !spend) {
      parts.push(usageError ? "$(warning) usage n/a" : usage ? "ไม่มี usage limit" : "กำลังโหลด usage…");
    }
    item.text = parts.join(" ");

    const worst = Math.max(five ? pct(five) : 0, week ? pct(week) : 0, spend ? spend.pct : 0);
    item.backgroundColor =
      worst >= 90
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : worst >= 70
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Claude usage limits**${plan ? ` · ${plan}` : ""}\n\n| | | |\n|---|---|---|\n`);
    const row = (label, w) =>
      w && md.appendMarkdown(`| ${label} | ${pct(w).toFixed(0)}% used | ${fmtReset(w.resets_at)} |\n`);
    row("Current session", five);
    row("Weekly · All models", week);
    row("Weekly · Opus", usage && usage.seven_day_opus);
    row("Weekly · Sonnet", usage && usage.seven_day_sonnet);
    if (spend) {
      md.appendMarkdown(`| Monthly spend | ${fmtMoney(spend.used)} / ${fmtMoney(spend.limit)} ${spend.currency} | ${spend.pct.toFixed(0)}% used |\n`);
    }
    if (usageError) md.appendMarkdown(`\n$(warning) ${usageError}\n`);
    if (usageAt) md.appendMarkdown(`\n_usage อัปเดต ${fmtDateTime(usageAt)}_\n`);

    if (s && s.model) {
      const ctxPct = Math.min((s.used / s.window) * 100, 100);
      md.appendMarkdown(`\n---\n\n**Session นี้** — \`${s.model}\`\n\n| | |\n|---|---|\n`);
      md.appendMarkdown(`| Context | ${fmtTokens(s.used)} / ${fmtTokens(s.window)} (${ctxPct.toFixed(0)}%) |\n`);
      md.appendMarkdown(`| Cost session / วันนี้ | $${s.sessionCost.toFixed(2)} / $${s.todayCost.toFixed(2)} |\n\n`);
      md.appendMarkdown(`_Cost = ราคา API โดยประมาณ ไม่ใช่ยอดที่จ่ายจริง_\n\n`);
    }
    md.appendMarkdown(`คลิกเพื่อ refresh`);
    item.tooltip = md;
    item.show();
  };

  const rateLimitMessage = (until) => `usage API rate limited (429) — ลองใหม่ ${fmtDateTime(until)} (คลิกเพื่อลองเลย)`;

  // manual = clicked refresh: fetch unless another window fetched in the last 30s,
  // even during a 429 backoff. Timer ticks reuse any result younger than the refresh interval.
  const refreshUsage = async (manual = false) => {
    shared = readShared();
    if (shared.at > usageAt) {
      usage = shared.usage;
      usageAt = shared.at;
      usageError = null;
    }
    const now = Date.now();
    const interval = Math.max(vscode.workspace.getConfiguration("claudeStatusbar").get("usageRefreshSeconds", 120), 30) * 1000;
    const minAge = manual ? 30000 : interval - 5000;
    if (!manual && now < (shared.backoffUntil || 0)) {
      usageError = rateLimitMessage(shared.backoffUntil);
      return render();
    }
    if (now < (shared.fetchingUntil || 0) || now - usageAt < minAge) return render();

    writeShared({ ...shared, fetchingUntil: now + 20000 });
    try {
      usage = await fetchUsage();
      usageError = null;
      usageAt = Date.now();
      writeShared({ usage, at: usageAt });
    } catch (err) {
      shared = readShared();
      if (err.statusCode === 429) {
        // Exponential backoff (1m, 2m, 4m ...), or Retry-After if longer, capped at 10m:
        // the server can send Retry-After of ~1h while the API already works again.
        const count = shared.backoffCount || 0;
        const delay = Math.min(Math.max(err.retryAfterMs || 0, 60000 * 2 ** count), 10 * 60000);
        const backoffUntil = Date.now() + delay;
        writeShared({ ...shared, backoffUntil, backoffCount: count + 1, fetchingUntil: 0 });
        usageError = rateLimitMessage(backoffUntil);
      } else {
        writeShared({ ...shared, fetchingUntil: 0 });
        usageError = err.message;
      }
    }
    render();
  };

  let timer;
  let usageTimer;
  const schedule = () => {
    clearInterval(timer);
    clearInterval(usageTimer);
    const cfg = vscode.workspace.getConfiguration("claudeStatusbar");
    timer = setInterval(render, Math.max(cfg.get("refreshSeconds", 5), 1) * 1000);
    usageTimer = setInterval(() => refreshUsage(), Math.max(cfg.get("usageRefreshSeconds", 120), 30) * 1000);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeStatusbar.refresh", () => refreshUsage(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeStatusbar")) {
        schedule();
        render();
      }
    }),
    { dispose: () => (clearInterval(timer), clearInterval(usageTimer)) }
  );

  render();
  refreshUsage();
  schedule();
}

function deactivate() {}

module.exports = { activate, deactivate, _internal: { collectStats, messageCost, prettyModel, fmtReset } };
