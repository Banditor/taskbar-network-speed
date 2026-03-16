import path from "node:path";
import { chromium } from "playwright";
import { CONFIG } from "./config.mjs";
import {
  HITS_DIR,
  SHOTS_DIR,
  ensureStateDirs,
  hasSuspiciousKeyword,
  normalizeUrl,
  nowIso,
  openUrlInBrowser,
  printLine,
  sleep,
  stampForFile,
  uniqSorted,
  writeJson
} from "./utils.mjs";

function parseFlags(argv) {
  const flags = {};
  for (const item of argv) {
    if (!item.startsWith("--")) {
      continue;
    }
    const [rawKey, rawValue] = item.slice(2).split("=");
    flags[rawKey] = rawValue === undefined ? true : rawValue;
  }
  return flags;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFilePart(route) {
  return route.replace(/^\//, "").replace(/[^a-zA-Z0-9_-]+/g, "-") || "root";
}

function canonicalizeText(value) {
  return String(value || "")
    .replace(/\d+/g, " ")
    .replace(/[:.,/\\|()[\]{}\-+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function hasStrongTreasureKeyword(value) {
  const lower = String(value || "").toLowerCase();
  const keywords = [
    "winner",
    "claim",
    "congrats",
    "found it",
    "you found",
    "treasure found",
    "זכית",
    "מצאת את",
    "מצאתם את",
    "מזל טוב",
    "לחץ לקבל",
    "קח את הפרס"
  ];
  return keywords.some((keyword) => lower.includes(keyword));
}

function classifyUrl(url) {
  const lower = String(url || "").toLowerCase();
  if (lower.startsWith("data:image/")) {
    return "inline-image";
  }
  if (CONFIG.likelyImageExtensions.some((ext) => lower.includes(ext))) {
    return "image";
  }
  if (lower.includes("/assets/")) {
    return "asset";
  }
  return "other";
}

async function safeScreenshot(page, route, runId) {
  const file = path.join(SHOTS_DIR, `${runId}-${toFilePart(route)}-turbo.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return null;
  }
}

async function clickMatching(page, keywords) {
  const lowered = keywords.map((item) => item.toLowerCase());
  const clicked = await page.evaluate((items) => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || 1) < 0.05
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 16 && rect.height > 16;
    };

    const nodes = Array.from(
      document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")
    );
    for (const node of nodes) {
      if (!visible(node)) {
        continue;
      }
      const haystack = [
        node.innerText || "",
        node.textContent || "",
        node.getAttribute("aria-label") || "",
        node.getAttribute("title") || ""
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack) {
        continue;
      }
      if (items.some((keyword) => haystack.includes(keyword))) {
        node.click();
        return haystack.slice(0, 160);
      }
    }
    return "";
  }, lowered);

  return Boolean(clicked);
}

async function runRouteNudge(page) {
  await clickMatching(page, CONFIG.closeKeywords);
  await sleep(100);

  for (const keyword of CONFIG.clickKeywords) {
    const clicked = await clickMatching(page, [keyword]);
    if (clicked) {
      await sleep(CONFIG.turboStepWaitMs);
    }
  }

  await page.evaluate(async () => {
    const distance = Math.max(500, Math.floor(window.innerHeight * 0.75));
    for (let i = 0; i < 4; i += 1) {
      window.scrollBy(0, distance);
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
  });
}

async function snapshotPage(page) {
  return page.evaluate(() => {
    const normalize = (value) => {
      if (!value || typeof value !== "string") {
        return null;
      }
      const trimmed = value.trim();
      return trimmed || null;
    };

    const visible = (el) => {
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || 1) < 0.05
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 12 && rect.height > 12;
    };

    const urls = new Set();
    const texts = new Set();

    for (const img of document.images) {
      const src = normalize(img.currentSrc || img.src);
      if (src) {
        urls.add(src);
      }
    }

    for (const meta of document.querySelectorAll(
      'meta[property="og:image"],meta[property="twitter:image"],meta[name="twitter:image"]'
    )) {
      const content = normalize(meta.getAttribute("content"));
      if (content) {
        urls.add(content);
      }
    }

    for (const el of document.querySelectorAll("div, section, article, aside, dialog, [role='dialog']")) {
      const bg = window.getComputedStyle(el).backgroundImage || "";
      const matches = bg.match(/url\(([^)]+)\)/gi) || [];
      for (const part of matches) {
        const raw = part.replace(/^url\(/i, "").replace(/\)$/i, "").replace(/["']/g, "");
        const value = normalize(raw);
        if (value) {
          urls.add(value);
        }
      }

      if (!visible(el)) {
        continue;
      }

      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const highSignal =
        style.position === "fixed" ||
        style.position === "sticky" ||
        Number.parseInt(style.zIndex || "0", 10) >= 20 ||
        rect.width > window.innerWidth * 0.45;
      if (!highSignal) {
        continue;
      }

      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (text.length >= 8) {
        texts.add(text.slice(0, 240));
      }
    }

    return {
      url: window.location.href,
      title: document.title || "",
      imageUrls: [...urls],
      overlayTexts: [...texts]
    };
  });
}

async function collectRouteEvents(routeState) {
  const rawEvents = await routeState.page.evaluate(() => {
    const events = Array.isArray(window.__treasureEvents) ? window.__treasureEvents.slice() : [];
    window.__treasureEvents = [];
    return events;
  });

  const normalized = [];
  for (const entry of rawEvents) {
    if (!entry) {
      continue;
    }
    const baseUrl = entry.baseUrl || routeState.page.url();
    const rawUrl = typeof entry.url === "string" ? entry.url : "";
    const url =
      rawUrl.startsWith("data:image/")
        ? rawUrl
        : normalizeUrl(rawUrl, baseUrl);
    const text = String(entry.text || "").trim();
    if (!url && !text) {
      continue;
    }
    normalized.push({
      kind: entry.kind || "event",
      url,
      text,
      route: routeState.route,
      pageUrl: routeState.page.url(),
      title: routeState.lastSnapshot.title || ""
    });
  }

  return normalized;
}

async function detectRouteHit(routeState, runId, seenGlobal) {
  const snapshot = await snapshotPage(routeState.page);
  routeState.lastSnapshot = {
    title: snapshot.title,
    overlayTexts: snapshot.overlayTexts
  };

  const events = await collectRouteEvents(routeState);
  const freshItems = [];

  for (const rawUrl of snapshot.imageUrls || []) {
    const url = rawUrl.startsWith("data:image/") ? rawUrl : normalizeUrl(rawUrl, snapshot.url);
    if (!url) {
      continue;
    }
    if (seenGlobal.urls.has(url)) {
      continue;
    }
    seenGlobal.urls.add(url);
    freshItems.push({
      kind: "snapshot-image",
      url,
      text: "",
      route: routeState.route,
      pageUrl: snapshot.url,
      title: snapshot.title
    });
  }

  for (const text of snapshot.overlayTexts || []) {
    const normalizedText = canonicalizeText(text);
    if (!normalizedText || seenGlobal.texts.has(normalizedText)) {
      continue;
    }
    seenGlobal.texts.add(normalizedText);
    freshItems.push({
      kind: "snapshot-overlay",
      url: snapshot.url,
      text,
      route: routeState.route,
      pageUrl: snapshot.url,
      title: snapshot.title
    });
  }

  for (const event of events) {
    const normalizedText = canonicalizeText(event.text || "");
    const dedupe = `${event.kind}|${event.url || ""}|${normalizedText}`;
    if (seenGlobal.events.has(dedupe)) {
      continue;
    }
    seenGlobal.events.add(dedupe);
    if (event.url) {
      seenGlobal.urls.add(event.url);
    }
    if (normalizedText) {
      seenGlobal.texts.add(normalizedText);
    }
    freshItems.push(event);
  }

  const suspicious = freshItems.filter((item) => {
    const kind = classifyUrl(item.url);
    if (kind === "inline-image" && !hasSuspiciousKeyword(item.text || "")) {
      return false;
    }
    if (item.kind === "snapshot-overlay" && !hasStrongTreasureKeyword(item.text || "")) {
      return false;
    }
    return (
      hasSuspiciousKeyword(item.url || "") ||
      hasSuspiciousKeyword(item.text || "") ||
      kind === "image"
    );
  });

  if (suspicious.length === 0) {
    return null;
  }

  const screenshotPath = await safeScreenshot(routeState.page, routeState.route, runId);
  const openTargets = uniqSorted(
    suspicious
      .map((item) => item.url || item.pageUrl)
      .filter(Boolean)
      .filter((item) => item.startsWith("http://") || item.startsWith("https://") || item.startsWith("data:image/"))
  ).slice(0, 8);

  return {
    timestamp: nowIso(),
    route: routeState.route,
    pageUrl: snapshot.url,
    pageTitle: snapshot.title,
    reasons: uniqSorted(
      suspicious.map((item) => {
        const signal = classifyUrl(item.url);
        if (item.kind.includes("overlay")) {
          return "new_overlay_signal";
        }
        if (signal === "image") {
          return "new_image_signal";
        }
        if (signal === "asset") {
          return "new_asset_signal";
        }
        return "new_signal";
      })
    ),
    events: suspicious,
    openTargets,
    screenshotPath
  };
}

async function buildRouteState(context, route) {
  const page = await context.newPage();
  const targetUrl = normalizeUrl(route, CONFIG.baseUrl);
  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: Math.max(CONFIG.fetchTimeoutMs, 45000)
  });
  await page.waitForTimeout(CONFIG.turboWarmWaitMs);
  await runRouteNudge(page);
  await page.waitForTimeout(CONFIG.turboWarmWaitMs);
  if (!page.url().startsWith(targetUrl)) {
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(CONFIG.fetchTimeoutMs, 45000)
    });
    await page.waitForTimeout(CONFIG.turboWarmWaitMs);
  }
  const snapshot = await snapshotPage(page);
  await page.evaluate(() => {
    window.__treasureEvents = [];
  });
  return {
    route,
    page,
    baselineImageUrls: snapshot.imageUrls,
    baselineOverlayTexts: snapshot.overlayTexts,
    lastSnapshot: {
      title: snapshot.title,
      overlayTexts: snapshot.overlayTexts
    }
  };
}

async function writeHit(runId, hit) {
  const file = path.join(HITS_DIR, `${runId}-${toFilePart(hit.route)}-turbo.json`);
  await writeJson(file, hit);
  return file;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const durationSec = toNumber(flags.duration, CONFIG.turboDurationSec);
  const pollMs = toNumber(flags.interval, CONFIG.turboPollMs);
  const openOnHit = flags["open-on-hit"] !== "false";
  const keepRunning = Boolean(flags["keep-running"]);
  const runId = `turbo-${stampForFile()}`;

  await ensureStateDirs();

  const browser = await chromium.launch({
    headless: flags.headful ? false : true
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    locale: "he-IL",
    userAgent: "Mozilla/5.0 TreasureTurbo/1.0"
  });

  await context.addInitScript(() => {
    window.__treasureEvents = [];
    window.__treasurePush = (payload) => {
      try {
        window.__treasureEvents.push({
          at: Date.now(),
          ...payload,
          baseUrl: window.location.href
        });
        if (window.__treasureEvents.length > 250) {
          window.__treasureEvents = window.__treasureEvents.slice(-250);
        }
      } catch {
        // ignore
      }
    };

    const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();

    const pushNodeSignals = (node) => {
      if (!(node instanceof Element)) {
        return;
      }

      if (node.tagName === "IMG") {
        const src = node.currentSrc || node.getAttribute("src") || "";
        if (src) {
          window.__treasurePush({ kind: "dom-image", url: src });
        }
      }

      if (node.matches("[role='dialog'], dialog, [role='alertdialog'], [data-state='open']")) {
        const text = normalizeText(node.innerText).slice(0, 240);
        if (text) {
          window.__treasurePush({ kind: "dom-overlay", text });
        }
      }

      const style = window.getComputedStyle(node);
      const bg = style.backgroundImage || "";
      const matches = bg.match(/url\(([^)]+)\)/gi) || [];
      for (const part of matches) {
        const raw = part.replace(/^url\(/i, "").replace(/\)$/i, "").replace(/["']/g, "");
        if (raw) {
          window.__treasurePush({ kind: "dom-background", url: raw });
        }
      }

      const text = normalizeText(node.textContent).slice(0, 240);
      if (text && /(gift|present|treasure|prize|bonus|giveaway|מתנה|אוצר|פרס|מטמון|הגרלה)/i.test(text)) {
        window.__treasurePush({ kind: "dom-text", text });
      }
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes" && mutation.target instanceof Element) {
          pushNodeSignals(mutation.target);
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) {
            continue;
          }
          pushNodeSignals(node);
          for (const child of node.querySelectorAll("img, [role='dialog'], dialog, [data-state='open'], *")) {
            pushNodeSignals(child);
          }
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "style", "class", "data-state", "open"]
    });

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      try {
        const url = String(args[0]?.url || args[0] || "");
        window.__treasurePush({ kind: "fetch", url });
      } catch {
        // ignore
      }
      return response;
    };

    const xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      try {
        window.__treasurePush({ kind: "xhr", url: String(url || "") });
      } catch {
        // ignore
      }
      return xhrOpen.call(this, method, url, ...rest);
    };
  });

  const seenGlobal = {
    urls: new Set(),
    texts: new Set(),
    events: new Set()
  };

  const routeStates = [];
  try {
    printLine("turbo", `warming ${CONFIG.hotRoutes.length} hot routes`);
    for (const route of CONFIG.hotRoutes) {
      let state = null;
      try {
        state = await buildRouteState(context, route);
      } catch (error) {
        printLine("warm warning", `${route}: ${String(error.message || error)}`);
        continue;
      }
      for (const url of state.baselineImageUrls || []) {
        seenGlobal.urls.add(url);
      }
      for (const text of state.baselineOverlayTexts || []) {
        const normalizedText = canonicalizeText(text);
        if (normalizedText) {
          seenGlobal.texts.add(normalizedText);
        }
      }
      routeStates.push(state);
      printLine("hot route", state.page.url());
    }

    printLine("turbo", `run_id=${runId} duration=${durationSec}s interval=${pollMs}ms`);
    const deadline = Date.now() + durationSec * 1000;
    let loop = 0;

    while (Date.now() < deadline) {
      loop += 1;
      for (const routeState of routeStates) {
        await runRouteNudge(routeState.page);
        const hit = await detectRouteHit(routeState, runId, seenGlobal);
        if (!hit) {
          continue;
        }

        const hitFile = await writeHit(runId, hit);
        printLine("TURBO HIT", `${hit.route} -> ${hit.openTargets[0] || hit.pageUrl}`);
        printLine("hit_file", hitFile);

        if (openOnHit) {
          for (const target of hit.openTargets.slice(0, 4)) {
            printLine("open", target);
            openUrlInBrowser(target);
          }
        }

        if (!keepRunning) {
          return;
        }
      }

      printLine("turbo loop", String(loop));
      await sleep(pollMs);
    }

    printLine("turbo", "no hit in current run");
  } finally {
    for (const routeState of routeStates) {
      await routeState.page.close().catch(() => {});
    }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
