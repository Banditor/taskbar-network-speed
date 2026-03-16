import path from "node:path";
import { CONFIG } from "./config.mjs";
import {
  SHOTS_DIR,
  fetchBinaryHash,
  hasSuspiciousKeyword,
  looksLikeImageUrl,
  normalizeUrl,
  printLine,
  sleep,
  uniqSorted
} from "./utils.mjs";

function routeToFilePart(route) {
  return route.replace(/^\//, "").replace(/[^a-zA-Z0-9_-]+/g, "-") || "root";
}

async function importPlaywright() {
  try {
    return await import("playwright");
  } catch {
    return null;
  }
}

async function collectDomSignals(page) {
  const payload = await page.evaluate(() => {
    const normalize = (value) => {
      if (!value || typeof value !== "string") {
        return null;
      }
      const trimmed = value.trim();
      if (!trimmed || trimmed.startsWith("data:")) {
        return null;
      }
      return trimmed;
    };

    const parseSrcset = (value) => {
      if (!value) {
        return [];
      }
      return value
        .split(",")
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean);
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
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.right > 0;
    };

    const urls = new Set();
    const overlayTexts = new Set();

    for (const img of document.querySelectorAll("img[src]")) {
      const src = normalize(img.getAttribute("src"));
      if (src) {
        urls.add(src);
      }
    }

    for (const source of document.querySelectorAll("source[src],source[srcset]")) {
      const src = normalize(source.getAttribute("src"));
      if (src) {
        urls.add(src);
      }
      for (const item of parseSrcset(source.getAttribute("srcset"))) {
        urls.add(item);
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

    for (const el of document.querySelectorAll("[style*='url('], div, section, article, aside")) {
      if (!visible(el)) {
        continue;
      }
      const inline = (el.getAttribute("style") || "").match(/url\(([^)]+)\)/gi) || [];
      for (const part of inline) {
        const raw = part.replace(/^url\(/i, "").replace(/\)$/i, "").replace(/["']/g, "");
        if (raw) {
          urls.add(raw);
        }
      }
      const computed = window.getComputedStyle(el).backgroundImage || "";
      const matches = computed.match(/url\(([^)]+)\)/gi) || [];
      for (const part of matches) {
        const raw = part.replace(/^url\(/i, "").replace(/\)$/i, "").replace(/["']/g, "");
        if (raw) {
          urls.add(raw);
        }
      }
    }

    for (const el of document.querySelectorAll("div, section, aside, dialog, [role='dialog'], [role='alertdialog']")) {
      if (!visible(el)) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const isOverlay =
        (style.position === "fixed" || style.position === "sticky") &&
        rect.width > window.innerWidth * 0.35 &&
        rect.height > 64;

      const highZ = Number.parseInt(style.zIndex || "0", 10) >= 30;
      if (!isOverlay && !highZ) {
        continue;
      }

      const text = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 240);
      if (text && text.length >= 8) {
        overlayTexts.add(text);
      }
    }

    return {
      imageUrls: [...urls],
      overlayTexts: [...overlayTexts],
      title: document.title || ""
    };
  });

  const normalizedUrls = payload.imageUrls
    .map((item) => normalizeUrl(item, page.url()))
    .filter(Boolean);

  return {
    title: payload.title,
    imageUrls: uniqSorted(normalizedUrls),
    overlayTexts: uniqSorted(payload.overlayTexts)
  };
}

async function clickByKeyword(page, keyword) {
  const selector = [
    `button:has-text("${keyword}")`,
    `a:has-text("${keyword}")`,
    `[role="button"]:has-text("${keyword}")`,
    `[aria-label*="${keyword}"]`
  ].join(", ");

  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) {
    return false;
  }
  try {
    await locator.click({ timeout: 900, force: true });
    return true;
  } catch {
    return false;
  }
}

async function closePopups(page) {
  let closedAny = false;
  for (const keyword of CONFIG.closeKeywords) {
    const clicked = await clickByKeyword(page, keyword);
    if (clicked) {
      closedAny = true;
      await sleep(250);
    }
  }
  return closedAny;
}

async function runRouteScript(page) {
  await closePopups(page);

  await page.evaluate(async () => {
    const distance = Math.max(600, Math.floor(window.innerHeight * 0.8));
    for (let i = 0; i < 8; i += 1) {
      window.scrollBy(0, distance);
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
  });

  for (const keyword of CONFIG.clickKeywords) {
    const clicked = await clickByKeyword(page, keyword);
    if (clicked) {
      await sleep(850);
    }
  }

  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  });
}

export async function runDynamicScan({
  baseline = null,
  scanId = "scan",
  captureScreenshots = true,
  mode = "quick"
} = {}) {
  const playwright = await importPlaywright();
  if (!playwright) {
    return {
      timestamp: new Date().toISOString(),
      stats: {
        routeCount: 0,
        scannedRoutes: 0,
        newDynamicUrlCount: 0,
        newOverlayCount: 0,
        suspiciousCount: 0
      },
      dynamic: {
        imageUrls: [],
        overlayTexts: [],
        routeFindings: []
      },
      diff: {
        newDynamicUrls: [],
        newOverlayTexts: [],
        suspiciousCandidates: []
      },
      warnings: [
        "Playwright not installed. Install with: npm i -D playwright && npx playwright install chromium"
      ]
    };
  }

  const { chromium } = playwright;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "he-IL",
    userAgent: "Mozilla/5.0 TreasureHunter/1.0"
  });

  const routeFindings = [];

  try {
    const routes = mode === "full" ? CONFIG.routes : CONFIG.watchRoutes;
    const dynamicWaitMs = mode === "full" ? CONFIG.dynamicWaitMs : CONFIG.quickDynamicWaitMs;
    const longWaitMs =
      mode === "full" ? CONFIG.longAnimationWaitMs : CONFIG.quickLongAnimationWaitMs;

    for (const route of routes) {
      const targetUrl = normalizeUrl(route, CONFIG.baseUrl);
      if (!targetUrl) {
        continue;
      }

      const page = await context.newPage();
      try {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: CONFIG.fetchTimeoutMs });
        await page.waitForLoadState("networkidle", { timeout: CONFIG.fetchTimeoutMs }).catch(() => {});

        const before = await collectDomSignals(page);
        await runRouteScript(page);
        await page.waitForTimeout(dynamicWaitMs);
        const mid = await collectDomSignals(page);

        // Covers late appearance at end of animations/tutorials.
        await page.waitForTimeout(longWaitMs);
        const after = await collectDomSignals(page);

        const allUrls = uniqSorted([...before.imageUrls, ...mid.imageUrls, ...after.imageUrls]);
        const allTexts = uniqSorted([...before.overlayTexts, ...mid.overlayTexts, ...after.overlayTexts]);

        let screenshotPath = null;
        if (captureScreenshots) {
          const file = `${scanId}-${routeToFilePart(route)}.png`;
          screenshotPath = path.join(SHOTS_DIR, file);
          await page.screenshot({ path: screenshotPath, fullPage: true });
        }

        routeFindings.push({
          route,
          url: targetUrl,
          title: after.title || mid.title || before.title,
          imageUrls: allUrls,
          overlayTexts: allTexts,
          screenshotPath
        });
      } catch (error) {
        routeFindings.push({
          route,
          url: targetUrl,
          title: "",
          imageUrls: [],
          overlayTexts: [],
          error: String(error),
          screenshotPath: null
        });
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const dynamicUrls = uniqSorted(routeFindings.flatMap((row) => row.imageUrls || []));
  const dynamicOverlayTexts = uniqSorted(routeFindings.flatMap((row) => row.overlayTexts || []));

  const imageUrlsToHash = (() => {
    const priority = dynamicUrls.filter((item) => {
      const lower = item.toLowerCase();
      return (
        hasSuspiciousKeyword(lower) ||
        lower.includes("glossary") ||
        lower.includes("giveaway") ||
        lower.includes("offers") ||
        lower.includes("social-images") ||
        lower.includes("og-images")
      );
    });
    const merged = uniqSorted([...priority, ...dynamicUrls]);
    const limit = mode === "full" ? 56 : 22;
    return merged.slice(0, limit);
  })();

  const imageHashRows = await Promise.all(
    imageUrlsToHash.map(async (url) => ({ url, hash: await fetchBinaryHash(url) }))
  );
  const imageContentHashes = Object.fromEntries(
    imageHashRows.filter((row) => row?.url && row?.hash).map((row) => [row.url, row.hash])
  );
  const prevDynamicImageHashes = baseline?.dynamic?.imageContentHashes || {};
  const changedDynamicImageContentUrls = Object.keys(imageContentHashes)
    .filter((url) => prevDynamicImageHashes[url] && prevDynamicImageHashes[url] !== imageContentHashes[url])
    .sort();

  const baselineDynamicUrls = new Set((baseline?.dynamic?.imageUrls || []).map((item) => item));
  const baselineOverlayTexts = new Set((baseline?.dynamic?.overlayTexts || []).map((item) => item));

  const newDynamicUrls = dynamicUrls.filter((item) => !baselineDynamicUrls.has(item));
  const newOverlayTexts = dynamicOverlayTexts.filter((item) => !baselineOverlayTexts.has(item));

  const suspiciousCandidates = uniqSorted(
    [...newDynamicUrls, ...newOverlayTexts, ...changedDynamicImageContentUrls].filter(
      (item) => hasSuspiciousKeyword(item) || looksLikeImageUrl(item)
    )
  );

  printLine("dynamic routes scanned", String(routeFindings.length));

  return {
    timestamp: new Date().toISOString(),
    stats: {
      routeCount: mode === "full" ? CONFIG.routes.length : CONFIG.watchRoutes.length,
      scannedRoutes: routeFindings.length,
      dynamicUrlCount: dynamicUrls.length,
      overlayCount: dynamicOverlayTexts.length,
      hashedImageCount: Object.keys(imageContentHashes).length,
      newDynamicUrlCount: newDynamicUrls.length,
      newOverlayCount: newOverlayTexts.length,
      changedImageContentCount: changedDynamicImageContentUrls.length,
      suspiciousCount: suspiciousCandidates.length
    },
    dynamic: {
      imageUrls: dynamicUrls,
      imageContentHashes,
      overlayTexts: dynamicOverlayTexts,
      routeFindings
    },
    diff: {
      newDynamicUrls,
      newOverlayTexts,
      changedDynamicImageContentUrls,
      suspiciousCandidates
    }
  };
}
