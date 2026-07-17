const express = require('express');
const cheerio = require('cheerio');
const { URL } = require('url');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ---------- إعدادات عامة ----------
const REQUEST_TIMEOUT_MS = 10000;
const MAX_CONCURRENCY_CAP = 500; // سقف أمان عشان محدش يستخدمها كأداة هجوم بالغلط
const MAX_PAGES_CAP = 50;

function isValidTargetUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// طلب واحد مع قياس الزمن وقطع الاتصال لو استنى كتير
async function timedFetch(url, opts = {}) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', ...opts });
    // نقرأ الجسم عشان نقيس الوقت الحقيقي للتحميل الكامل مش بس الهيدرز
    await res.arrayBuffer();
    return { ok: res.ok, status: res.status, time: Date.now() - start, headers: res.headers };
  } catch (err) {
    return { ok: false, status: 0, time: Date.now() - start, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- اختبار الضغط (Load Test) ----------
// بيشتغل على شكل "موجات" بتزيد في عدد الطلبات المتزامنة لحد ما يلاقي نقطة الانهيار
async function runLoadTest(targetUrl, maxConcurrency) {
  const waves = [5, 10, 25, 50, 100, 200, 300, 500].filter((w) => w <= maxConcurrency);
  const results = [];
  let breakingPoint = null;

  for (const concurrency of waves) {
    const waveStart = Date.now();
    const promises = Array.from({ length: concurrency }, () => timedFetch(targetUrl));
    const settled = await Promise.all(promises);
    const waveDuration = Date.now() - waveStart;

    const successCount = settled.filter((r) => r.ok).length;
    const failCount = concurrency - successCount;
    const times = settled.map((r) => r.time);
    const avgTime = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    const maxTime = Math.max(...times);
    const minTime = Math.min(...times);
    const failRate = failCount / concurrency;
    const requestsPerSecond = Math.round((concurrency / waveDuration) * 1000);

    const waveResult = {
      concurrency,
      successCount,
      failCount,
      failRatePercent: Math.round(failRate * 100),
      avgResponseTimeMs: avgTime,
      minResponseTimeMs: minTime,
      maxResponseTimeMs: maxTime,
      requestsPerSecond,
    };
    results.push(waveResult);

    // نعتبرها نقطة انهيار لو أكتر من 30% من الطلبات فشلت أو الزمن اتضاعف بشكل خطير
    if (failRate > 0.3 || avgTime > 8000) {
      breakingPoint = { atConcurrency: concurrency, reason: failRate > 0.3 ? 'high_failure_rate' : 'high_latency' };
      break;
    }
  }

  return { waves: results, breakingPoint, maxTestedConcurrency: results.at(-1)?.concurrency ?? 0 };
}

app.post('/api/loadtest', async (req, res) => {
  const { url, maxConcurrency, confirmedOwnership } = req.body || {};

  if (!isValidTargetUrl(url)) {
    return res.status(400).json({ error: 'رابط غير صالح' });
  }
  if (!confirmedOwnership) {
    return res.status(400).json({ error: 'لازم تأكيد إنك تملك الموقع أو عندك إذن لفحصه' });
  }

  const cap = Math.min(Number(maxConcurrency) || 200, MAX_CONCURRENCY_CAP);

  try {
    const report = await runLoadTest(url, cap);
    res.json({ url, ...report });
  } catch (err) {
    res.status(500).json({ error: 'حصل خطأ أثناء الاختبار', details: err.message });
  }
});

// ---------- الفحص الشامل (Audit) ----------
function extractInternalLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const links = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    try {
      const resolved = new URL(href, base);
      if (resolved.hostname === base.hostname && (resolved.protocol === 'http:' || resolved.protocol === 'https:')) {
        resolved.hash = '';
        links.add(resolved.toString());
      }
    } catch {
      // رابط غير صالح، نتجاهله
    }
  });

  return Array.from(links);
}

function checkSecurityHeaders(headers) {
  const wanted = [
    'content-security-policy',
    'x-frame-options',
    'strict-transport-security',
    'x-content-type-options',
  ];
  const missing = wanted.filter((h) => !headers.has(h));
  return missing;
}

async function collectConsoleErrors(url) {
  // Playwright اختياري: لو مش متثبت، نتجاهل هذا الجزء بدل ما نفشل الفحص كله
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return { supported: false, errors: [] };
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  try {
    await page.goto(url, { waitUntil: 'load', timeout: REQUEST_TIMEOUT_MS });
  } catch (err) {
    errors.push(`فشل تحميل الصفحة في المتصفح: ${err.message}`);
  } finally {
    await browser.close();
  }

  return { supported: true, errors };
}

app.post('/api/audit', async (req, res) => {
  const { url, maxPages, confirmedOwnership } = req.body || {};

  if (!isValidTargetUrl(url)) {
    return res.status(400).json({ error: 'رابط غير صالح' });
  }
  if (!confirmedOwnership) {
    return res.status(400).json({ error: 'لازم تأكيد إنك تملك الموقع أو عندك إذن لفحصه' });
  }

  const pageCap = Math.min(Number(maxPages) || 15, MAX_PAGES_CAP);

  try {
    const homeResult = await timedFetch(url);
    if (!homeResult.ok) {
      return res.status(200).json({
        url,
        error: 'الصفحة الرئيسية مش راجعة رد سليم',
        status: homeResult.status,
      });
    }

    const homeRes = await fetch(url);
    const html = await homeRes.text();
    const links = extractInternalLinks(html, url).slice(0, pageCap - 1);
    const pagesToCheck = [url, ...links];

    const brokenLinks = [];
    const slowPages = [];
    const pageResults = [];

    for (const pageUrl of pagesToCheck) {
      const result = await timedFetch(pageUrl);
      pageResults.push({ url: pageUrl, status: result.status, timeMs: result.time });
      if (!result.ok) brokenLinks.push({ url: pageUrl, status: result.status, error: result.error });
      if (result.time > 2000) slowPages.push({ url: pageUrl, timeMs: result.time });
    }

    const missingSecurityHeaders = checkSecurityHeaders(homeRes.headers);
    const consoleCheck = await collectConsoleErrors(url);

    res.json({
      url,
      pagesScanned: pageResults.length,
      pageResults,
      brokenLinks,
      slowPages,
      missingSecurityHeaders,
      consoleErrors: consoleCheck.errors,
      browserCheckSupported: consoleCheck.supported,
    });
  } catch (err) {
    res.status(500).json({ error: 'حصل خطأ أثناء الفحص', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`الأداة شغالة على http://localhost:${PORT}`);
});
