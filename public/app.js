const urlInput = document.getElementById('targetUrl');
const confirmCheckbox = document.getElementById('confirmOwnership');
const maxConcurrencyInput = document.getElementById('maxConcurrency');
const maxPagesInput = document.getElementById('maxPages');

const runLoadTestBtn = document.getElementById('runLoadTest');
const runAuditBtn = document.getElementById('runAudit');

const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const errorBox = document.getElementById('errorBox');

const loadResultsEl = document.getElementById('loadResults');
const wavesContainer = document.getElementById('wavesContainer');
const breakingPointEl = document.getElementById('breakingPoint');

const auditResultsEl = document.getElementById('auditResults');

function resetUI() {
  errorBox.classList.add('hidden');
  loadResultsEl.classList.add('hidden');
  auditResultsEl.classList.add('hidden');
}

function setLoading(isLoading, text) {
  statusEl.classList.toggle('hidden', !isLoading);
  statusText.textContent = text || 'جاري الفحص...';
  runLoadTestBtn.disabled = isLoading;
  runAuditBtn.disabled = isLoading;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
}

function getInputs() {
  const url = urlInput.value.trim();
  const confirmedOwnership = confirmCheckbox.checked;
  if (!url) {
    showError('لازم تحط رابط الموقع الأول');
    return null;
  }
  if (!confirmedOwnership) {
    showError('لازم تأكد إنك تملك الموقع أو عندك إذن لفحصه');
    return null;
  }
  return { url, confirmedOwnership };
}

function waveColor(wave) {
  if (wave.failRatePercent > 30 || wave.avgResponseTimeMs > 8000) return 'var(--fail)';
  if (wave.failRatePercent > 5 || wave.avgResponseTimeMs > 3000) return 'var(--warn)';
  return 'var(--ok)';
}

function renderLoadResults(data) {
  wavesContainer.innerHTML = '';
  const maxTime = Math.max(...data.waves.map((w) => w.avgResponseTimeMs), 1);

  data.waves.forEach((wave) => {
    const row = document.createElement('div');
    row.className = 'wave-row';

    const label = document.createElement('div');
    label.className = 'wave-row__label';
    label.textContent = `${wave.concurrency} زائر`;

    const barTrack = document.createElement('div');
    barTrack.className = 'wave-row__bar-track';
    const barFill = document.createElement('div');
    barFill.className = 'wave-row__bar-fill';
    const widthPercent = Math.min(100, Math.round((wave.avgResponseTimeMs / maxTime) * 100));
    barFill.style.width = `${widthPercent}%`;
    barFill.style.background = waveColor(wave);
    barTrack.appendChild(barFill);

    const meta = document.createElement('div');
    meta.className = 'wave-row__meta';
    meta.textContent = `${wave.avgResponseTimeMs}ms · فشل ${wave.failRatePercent}%`;

    row.append(label, barTrack, meta);
    wavesContainer.appendChild(row);
  });

  if (data.breakingPoint) {
    breakingPointEl.className = 'breaking-point fail';
    const reason = data.breakingPoint.reason === 'high_failure_rate' ? 'نسبة فشل عالية في الطلبات' : 'زمن استجابة بطيء جدًا';
    breakingPointEl.textContent = `⚠ الموقع بدأ يتعب عند ${data.breakingPoint.atConcurrency} زائر متزامن (السبب: ${reason})`;
  } else {
    breakingPointEl.className = 'breaking-point ok';
    breakingPointEl.textContent = `✓ الموقع استحمل لحد ${data.maxTestedConcurrency} زائر متزامن من غير مشاكل واضحة`;
  }

  loadResultsEl.classList.remove('hidden');
}

function renderList(elementId, items, formatter) {
  const el = document.getElementById(elementId);
  el.innerHTML = '';
  items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = formatter(item);
    el.appendChild(li);
  });
}

function renderAuditResults(data) {
  document.getElementById('auditSummary').textContent =
    `تم فحص ${data.pagesScanned} صفحة · ${data.brokenLinks.length} رابط مكسور · ${data.slowPages.length} صفحة بطيئة`;

  renderList('brokenLinksList', data.brokenLinks, (item) => `${item.url} — ${item.status || item.error}`);
  renderList('slowPagesList', data.slowPages, (item) => `${item.url} — ${item.timeMs}ms`);
  renderList('securityHeadersList', data.missingSecurityHeaders, (item) => item);

  if (!data.browserCheckSupported) {
    renderList('consoleErrorsList', ['فحص أخطاء JavaScript محتاج تثبيت Playwright — راجع الـ README'], (m) => m);
  } else {
    renderList('consoleErrorsList', data.consoleErrors, (m) => m);
  }

  auditResultsEl.classList.remove('hidden');
}

runLoadTestBtn.addEventListener('click', async () => {
  resetUI();
  const inputs = getInputs();
  if (!inputs) return;

  setLoading(true, 'جاري رفع الضغط تدريجيًا على الموقع...');
  try {
    const res = await fetch('/api/loadtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...inputs,
        maxConcurrency: Number(maxConcurrencyInput.value),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showError(data.error || 'حصل خطأ');
    } else {
      renderLoadResults(data);
    }
  } catch (err) {
    showError('فشل الاتصال بالسيرفر: ' + err.message);
  } finally {
    setLoading(false);
  }
});

runAuditBtn.addEventListener('click', async () => {
  resetUI();
  const inputs = getInputs();
  if (!inputs) return;

  setLoading(true, 'جاري الفحص الشامل للموقع...');
  try {
    const res = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...inputs,
        maxPages: Number(maxPagesInput.value),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showError(data.error || 'حصل خطأ');
    } else if (data.error) {
      showError(data.error);
    } else {
      renderAuditResults(data);
    }
  } catch (err) {
    showError('فشل الاتصال بالسيرفر: ' + err.message);
  } finally {
    setLoading(false);
  }
});
