import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { CONFIG } from "./config.mjs";

export const STATE_DIR = path.resolve(CONFIG.outputDir);
export const BASELINE_FILE = path.join(STATE_DIR, "baseline.json");
export const LAST_SCAN_FILE = path.join(STATE_DIR, "last-scan.json");
export const HITS_DIR = path.join(STATE_DIR, "hits");
export const SHOTS_DIR = path.join(STATE_DIR, "shots");

export async function ensureStateDirs() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.mkdir(HITS_DIR, { recursive: true });
  await fs.mkdir(SHOTS_DIR, { recursive: true });
}

export function hashText(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

export function stampForFile() {
  return new Date().toISOString().replace(/[T:.]/g, "-").replace("Z", "");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqSorted(values) {
  return [...new Set(values)].sort();
}

export async function readJsonIfExists(file, fallback = null) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJson(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function normalizeUrl(raw, baseUrl) {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("javascript:")) {
    return null;
  }
  try {
    if (trimmed.startsWith("//")) {
      const url = new URL(`https:${trimmed}`);
      url.hash = "";
      return url.href;
    }
    const url = new URL(trimmed, baseUrl);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function hasSuspiciousKeyword(text, keywords = CONFIG.suspiciousKeywords) {
  const lower = String(text || "").toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

export function looksLikeImageUrl(url) {
  if (!url) {
    return false;
  }
  const lower = url.toLowerCase();
  return CONFIG.likelyImageExtensions.some((ext) => lower.includes(ext));
}

export function extractUrlsFromText(text, baseUrl) {
  const urls = [];
  const patterns = [
    /(?:src|href|content|poster)=["']([^"']+)["']/gi,
    /url\(([^)]+)\)/gi,
    /https?:\/\/[^"'\s)]+/gi,
    /\/assets\/[^"'\s)]+/gi,
    /\/[a-zA-Z0-9_\-./]+\.(?:png|jpg|jpeg|webp|gif|svg|avif)/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const candidate = match[1] ? match[1].replace(/["']/g, "") : match[0];
      const normalized = normalizeUrl(candidate, baseUrl);
      if (normalized) {
        urls.push(normalized);
      }
    }
  }
  return uniqSorted(urls);
}

export async function fetchText(url, timeoutMs = CONFIG.fetchTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 TreasureHunter/1.0",
        "cache-control": "no-cache"
      }
    });
    if (!response.ok) {
      return { ok: false, status: response.status, text: "" };
    }
    const text = await response.text();
    return { ok: true, status: response.status, text };
  } catch {
    return { ok: false, status: 0, text: "" };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBinaryHash(url, timeoutMs = CONFIG.fetchTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 TreasureHunter/1.0",
        "cache-control": "no-cache"
      }
    });
    if (!response.ok) {
      return null;
    }
    const arr = await response.arrayBuffer();
    const buf = Buffer.from(arr);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function runOne() {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await worker(items[current], current);
      } catch (error) {
        results[current] = { error: String(error) };
      }
    }
  }
  const runners = Array.from({ length: Math.max(1, limit) }, () => runOne());
  await Promise.all(runners);
  return results;
}

export function openUrlInBrowser(url) {
  if (!url) {
    return;
  }
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Non-fatal, keep scanning.
  }
}

export function printLine(label, value = "") {
  const prefix = `[treasure] ${label}`;
  // Keep output compact for fast reading during live hunt.
  console.log(value ? `${prefix}: ${value}` : prefix);
}
