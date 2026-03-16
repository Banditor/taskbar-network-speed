import { CONFIG } from "./config.mjs";
import {
  fetchText,
  fetchBinaryHash,
  extractUrlsFromText,
  hashText,
  mapLimit,
  normalizeUrl,
  uniqSorted,
  looksLikeImageUrl,
  hasSuspiciousKeyword,
  printLine
} from "./utils.mjs";

function parseSitemapUrls(xml, baseUrl) {
  const urls = [];
  const regex = /<loc>([^<]+)<\/loc>/gi;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const normalized = normalizeUrl(match[1], baseUrl);
    if (normalized) {
      urls.push(normalized);
    }
  }
  return uniqSorted(urls);
}

function compactHtml(html) {
  return html.replace(/\s+/g, " ").trim();
}

function relPath(url, baseUrl) {
  try {
    const base = new URL(baseUrl);
    const value = new URL(url);
    if (value.origin === base.origin) {
      return value.pathname + value.search;
    }
  } catch {
    // ignore
  }
  return url;
}

export async function runStaticScan({ baseline = null, mode = "quick" } = {}) {
  const sitemapUrl = `${CONFIG.baseUrl.replace(/\/$/, "")}/sitemap.xml`;
  const shouldUseSitemap = mode === "full";
  const sitemapResp = shouldUseSitemap ? await fetchText(sitemapUrl) : { ok: false, text: "" };

  let pageUrls = CONFIG.routes.map((route) => normalizeUrl(route, CONFIG.baseUrl)).filter(Boolean);
  if (shouldUseSitemap && sitemapResp.ok && sitemapResp.text) {
    pageUrls = uniqSorted([...pageUrls, ...parseSitemapUrls(sitemapResp.text, CONFIG.baseUrl)]);
  }
  if (mode === "quick") {
    const watch = CONFIG.watchRoutes.map((route) => normalizeUrl(route, CONFIG.baseUrl)).filter(Boolean);
    pageUrls = uniqSorted([...pageUrls, ...watch]).slice(0, CONFIG.quickMaxPages);
  } else {
    pageUrls = pageUrls.slice(0, CONFIG.maxPagesFromSitemap);
  }

  printLine("static pages queued", String(pageUrls.length));

  const pageResults = await mapLimit(pageUrls, CONFIG.pageConcurrency, async (url) => {
    const resp = await fetchText(url);
    if (!resp.ok) {
      return {
        url,
        ok: false,
        status: resp.status,
        pageHash: null,
        urls: [],
        imageUrls: [],
        scriptAssets: []
      };
    }

    const urls = extractUrlsFromText(resp.text, url);
    const imageUrls = urls.filter((item) => looksLikeImageUrl(item));
    const scriptAssets = urls.filter(
      (item) => item.includes("/assets/") && item.toLowerCase().endsWith(".js")
    );

    return {
      url,
      ok: true,
      status: resp.status,
      pageHash: hashText(compactHtml(resp.text)),
      urls,
      imageUrls,
      scriptAssets
    };
  });

  const okPages = pageResults.filter((row) => row.ok);
  const staticUrls = uniqSorted(okPages.flatMap((row) => row.urls));
  const staticImageUrls = uniqSorted(okPages.flatMap((row) => row.imageUrls));
  const scriptAssets = uniqSorted(okPages.flatMap((row) => row.scriptAssets));

  const scriptAssetsToScan =
    mode === "full" ? scriptAssets : scriptAssets.slice(0, Math.min(16, scriptAssets.length));
  printLine("static script assets", `${scriptAssetsToScan.length}/${scriptAssets.length}`);

  const assetResults = await mapLimit(scriptAssetsToScan, CONFIG.assetConcurrency, async (assetUrl) => {
    const resp = await fetchText(assetUrl);
    if (!resp.ok) {
      return { url: assetUrl, ok: false, urls: [], imageUrls: [] };
    }
    const urls = extractUrlsFromText(resp.text, assetUrl);
    return {
      url: assetUrl,
      ok: true,
      urls,
      imageUrls: urls.filter((item) => looksLikeImageUrl(item))
    };
  });

  const assetUrls = uniqSorted(assetResults.filter((row) => row.ok).flatMap((row) => row.urls));
  const assetImageUrls = uniqSorted(
    assetResults.filter((row) => row.ok).flatMap((row) => row.imageUrls)
  );

  const allUrls = uniqSorted([...staticUrls, ...assetUrls]);
  const allImageUrls = uniqSorted([...staticImageUrls, ...assetImageUrls]);
  const pageHashes = Object.fromEntries(
    okPages.map((row) => [relPath(row.url, CONFIG.baseUrl), row.pageHash])
  );

  const baselineUrls = new Set((baseline?.static?.allUrls || []).map((item) => item));
  const baselineImageUrls = new Set((baseline?.static?.imageUrls || []).map((item) => item));

  const newUrls = allUrls.filter((item) => !baselineUrls.has(item));
  const newImageUrls = allImageUrls.filter((item) => !baselineImageUrls.has(item));

  const imageUrlsToHash = (() => {
    const priority = allImageUrls.filter((item) => {
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
    const merged = uniqSorted([...priority, ...allImageUrls]);
    const limit = mode === "full" ? 56 : 20;
    return merged.slice(0, limit);
  })();

  const imageHashRows = await mapLimit(
    imageUrlsToHash,
    Math.min(6, CONFIG.assetConcurrency),
    async (url) => ({ url, hash: await fetchBinaryHash(url) })
  );
  const imageContentHashes = Object.fromEntries(
    imageHashRows.filter((row) => row?.url && row?.hash).map((row) => [row.url, row.hash])
  );
  const prevImageHashes = baseline?.static?.imageContentHashes || {};
  const changedImageContentUrls = Object.keys(imageContentHashes)
    .filter((url) => prevImageHashes[url] && prevImageHashes[url] !== imageContentHashes[url])
    .sort();

  const previousHashes = baseline?.static?.pageHashes || {};
  const changedPages = Object.entries(pageHashes)
    .filter(([path, hash]) => previousHashes[path] && previousHashes[path] !== hash)
    .map(([path]) => path)
    .sort();

  const newPages = Object.keys(pageHashes)
    .filter((path) => !Object.prototype.hasOwnProperty.call(previousHashes, path))
    .sort();

  const suspiciousCandidates = uniqSorted(
    [...newImageUrls, ...newUrls, ...changedImageContentUrls]
      .filter((item) => looksLikeImageUrl(item) || hasSuspiciousKeyword(item))
      .filter((item) => {
        const path = relPath(item, CONFIG.baseUrl).toLowerCase();
        const isLikelyPageLink =
          !looksLikeImageUrl(item) &&
          !path.includes("/assets/") &&
          !path.includes("storage") &&
          !path.includes("social-images") &&
          !path.includes("og-images") &&
          !path.includes("uploads/") &&
          !/[.](png|jpg|jpeg|webp|gif|svg|avif)(\\?|$)/i.test(path);
        if (isLikelyPageLink) {
          return false;
        }
        return (
          hasSuspiciousKeyword(path) ||
          path.includes("glossary") ||
          path.includes("giveaway") ||
          path.includes("offers") ||
          looksLikeImageUrl(item)
        );
      })
  );

  return {
    timestamp: new Date().toISOString(),
    stats: {
      pageCount: pageUrls.length,
      okPageCount: okPages.length,
      scriptAssetCount: scriptAssets.length,
      allUrlCount: allUrls.length,
      allImageUrlCount: allImageUrls.length,
      hashedImageCount: Object.keys(imageContentHashes).length,
      newUrlCount: newUrls.length,
      newImageUrlCount: newImageUrls.length,
      changedImageContentCount: changedImageContentUrls.length,
      changedPageCount: changedPages.length
    },
    pages: {
      changedPages,
      newPages
    },
    static: {
      allUrls,
      imageUrls: allImageUrls,
      imageContentHashes,
      pageHashes,
      scriptAssets
    },
    diff: {
      newUrls,
      newImageUrls,
      changedImageContentUrls,
      suspiciousCandidates
    }
  };
}
