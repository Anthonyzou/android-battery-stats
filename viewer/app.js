import { parseBatteryStats } from '../src/parse.js';
import { formatDuration } from '../src/format.js';

const HOUR_MS = 3_600_000;
const INITIAL_ROWS = 25;
const SVG_NS = 'http://www.w3.org/2000/svg';
const STATE_SEGMENTS = [
  { key: 'fgMah', cls: 'fg', label: 'Foreground' },
  { key: 'fgsMah', cls: 'fgs', label: 'Foreground service' },
  { key: 'bgMah', cls: 'bg', label: 'Background' },
  { key: 'cachedMah', cls: 'cached', label: 'Cached' },
];
const BANDS = [
  { key: 'screen', label: 'Screen on' },
  { key: 'running', label: 'CPU awake' },
  { key: 'plugged', label: 'Plugged in' },
];

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

const mah = (v) => (v === null ? 'n/a' : `${Math.round(v)} mAh`);
const pctOf = (part, whole) => (part === null || !whole ? null : (part / whole) * 100);
const fmtPct = (p) => (p === null ? '' : `${p.toFixed(1)}%`);
const perHour = (value, ms) => (value === null || !ms ? null : value / (ms / HOUR_MS));

function card(label, value, sub) {
  return el('div', { class: 'card' }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value), sub ? el('div', { class: 'sub' }, sub) : null);
}

function renderOverview(report) {
  const s = report.stats;
  const cap = s.estimatedCapacityMah;
  const offRateMah = perHour(s.screenOffDischargeMah, s.screenOffOnBatteryMs);
  const onRateMah = perHour(s.screenOnDischargeMah, s.screenOnMs);
  const pctPerHour = (rate) => (rate === null || !cap ? null : `${((rate / cap) * 100).toFixed(1)}%/h`);
  const steps = report.dischargeSteps;

  $('overview').replaceChildren(
    card('Started', s.startClockTime ?? 'n/a'),
    card('Time on battery', formatDuration(s.timeOnBatteryMs)),
    card('Screen on', formatDuration(s.screenOnMs), fmtPct(pctOf(s.screenOnMs, s.timeOnBatteryMs))),
    card('Screen off', formatDuration(s.screenOffOnBatteryMs), fmtPct(pctOf(s.screenOffOnBatteryMs, s.timeOnBatteryMs))),
    card('Total discharge', mah(s.dischargeMah), s.dischargedPercentLow === null ? null : `${s.dischargedPercentLow}–${s.dischargedPercentHigh}% of battery`),
    card('Screen-on drain', mah(s.screenOnDischargeMah), [onRateMah && `${Math.round(onRateMah)} mAh/h`, pctPerHour(onRateMah)].filter(Boolean).join(' · ')),
    card('Screen-off drain', mah(s.screenOffDischargeMah), [offRateMah && `${Math.round(offRateMah)} mAh/h`, pctPerHour(offRateMah)].filter(Boolean).join(' · ')),
    card('Deep doze drain', mah(s.deepDozeDischargeMah)),
    card('Partial wakelocks', formatDuration(s.partialWakelockMs), `full ${formatDuration(s.fullWakelockMs)}`),
    card('Battery capacity', mah(cap), s.learnedCapacityMah === null ? null : `learned ${mah(s.learnedCapacityMah)}`),
    ...(steps.count > 0
      ? [card('Time per 1%', formatDuration(steps.avgMsPerPercent), `on ${formatDuration(steps.avgMsPerPercentScreenOn)} · off ${formatDuration(steps.avgMsPerPercentScreenOff)}`)]
      : []),
    ...(report.history?.maxTempC != null ? [card('Temperature', `${report.history.minTempC}–${report.history.maxTempC} °C`)] : []),
  );
}

function wallClock(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function renderTimeline(history) {
  const host = $('timeline');
  if (!history || history.levels.length < 2) {
    host.replaceChildren(el('p', { class: 'muted' }, 'No battery history in this file.'));
    return;
  }
  const W = 1000;
  const chartH = 180;
  const bandH = 12;
  const bandGap = 4;
  const left = 80;
  const right = 8;
  const top = 8;
  const bandsTop = top + chartH + 24;
  const H = bandsTop + BANDS.length * (bandH + bandGap) + 4;
  const t0 = history.levels[0].t;
  const t1 = history.levels.at(-1).t;
  const span = Math.max(t1 - t0, 1);
  const x = (t) => left + ((t - t0) / span) * (W - left - right);
  const y = (level) => top + (1 - level / 100) * chartH;

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Battery level over time' });

  for (const level of [0, 25, 50, 75, 100]) {
    root.append(svg('line', { class: 'grid-line', x1: left, x2: W - right, y1: y(level), y2: y(level) }));
    const label = svg('text', { x: left - 6, y: y(level) + 4, 'text-anchor': 'end' });
    label.textContent = `${level}%`;
    root.append(label);
  }
  const tickCount = 6;
  for (let i = 0; i <= tickCount; i++) {
    const t = t0 + (span * i) / tickCount;
    const label = svg('text', { x: x(t), y: top + chartH + 16, 'text-anchor': i === 0 ? 'start' : i === tickCount ? 'end' : 'middle' });
    label.textContent = wallClock(t);
    root.append(label);
  }

  let path = '';
  let prevLevel = null;
  for (const { t, level } of history.levels) {
    path += path === '' ? `M${x(t)},${y(level)}` : `H${x(t)}V${y(level)}`;
    prevLevel = level;
  }
  path += `H${x(t1)}V${y(prevLevel)}`;
  root.append(svg('path', { class: 'level-area', d: `${path}V${y(0)}H${x(t0)}Z` }));
  root.append(svg('path', { class: 'level', d: path }));

  BANDS.forEach((band, i) => {
    const by = bandsTop + i * (bandH + bandGap);
    const label = svg('text', { x: left - 6, y: by + bandH - 2, 'text-anchor': 'end' });
    label.textContent = band.label;
    root.append(label);
    root.append(svg('rect', { x: left, y: by, width: W - left - right, height: bandH, fill: 'var(--bg)' }));
    for (const [a, b] of history.intervals[band.key]) {
      root.append(svg('rect', { class: `band-${band.key}`, x: x(a), y: by, width: Math.max(x(b) - x(a), 0.5), height: bandH }));
    }
  });

  const legend = el(
    'div',
    { class: 'legend' },
    el('span', {}, el('i', { style: 'background: var(--accent)' }), `Level ${history.startLevel}% → ${history.endLevel}%`),
    ...BANDS.map((b) => el('span', {}, el('i', { style: `background: var(--${b.key})` }), b.label)),
  );
  host.replaceChildren(legend, root);
}

function sortableTable(columns, rows, { initialSort, limit = INITIAL_ROWS } = {}) {
  const wrap = el('div');
  let sortIdx = initialSort ?? -1;
  let dir = 'desc';
  let showAll = rows.length <= limit;

  const draw = () => {
    const sorted = sortIdx < 0 ? rows : [...rows].sort((a, b) => {
      const va = columns[sortIdx].value(a);
      const vb = columns[sortIdx].value(b);
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : (va ?? -Infinity) - (vb ?? -Infinity);
      return dir === 'asc' ? cmp : -cmp;
    });
    const visible = showAll ? sorted : sorted.slice(0, limit);
    const head = el('tr', {}, ...columns.map((c, i) => {
      const th = el('th', i === sortIdx ? { 'data-dir': dir } : {}, c.label);
      if (c.value) {
        th.addEventListener('click', () => {
          dir = sortIdx === i && dir === 'desc' ? 'asc' : 'desc';
          sortIdx = i;
          draw();
        });
      }
      return th;
    }));
    const body = visible.map((r) => el('tr', {}, ...columns.map((c) => {
      const content = c.render ? c.render(r) : String(c.value(r));
      return el('td', c.cls ? { class: c.cls } : {}, content);
    })));
    const more = rows.length > limit
      ? el('div', { class: 'more' }, (() => {
          const btn = el('button', {}, showAll ? 'Show fewer' : `Show all ${rows.length}`);
          btn.addEventListener('click', () => { showAll = !showAll; draw(); });
          return btn;
        })())
      : null;
    wrap.replaceChildren(el('table', {}, el('thead', {}, head), el('tbody', {}, ...body)), more ?? '');
  };
  draw();
  return wrap;
}

function bar(segments, max) {
  const b = el('div', { class: 'bar' });
  for (const { value, cls } of segments) {
    if (value > 0) b.append(el('span', { class: cls, style: `width:${(value / max) * 100}%` }));
  }
  return b;
}

function renderComponents(report) {
  const total = report.stats.dischargeMah;
  const max = Math.max(...report.components.map((c) => c.mah), 1);
  $('components').replaceChildren(
    report.components.length === 0
      ? el('p', { class: 'muted' }, 'No component data.')
      : sortableTable(
          [
            { label: 'Component', value: (c) => c.name },
            { label: 'mAh', value: (c) => c.mah, render: (c) => c.mah.toFixed(1) },
            { label: 'Share', value: (c) => c.mah, render: (c) => fmtPct(pctOf(c.mah, total)) },
            { label: '', render: (c) => bar([{ value: c.mah, cls: 'one' }], max) },
          ],
          report.components,
        ),
  );
}

function renderRadio(report) {
  const r = report.radio;
  const items = [['Wi-Fi', r.wifiMah], ['Cellular', r.cellularMah], ['GPS', r.gpsMah]];
  const max = Math.max(...items.map(([, v]) => v ?? 0), 1);
  $('radio').replaceChildren(
    sortableTable(
      [
        { label: 'Radio', value: ([n]) => n },
        { label: 'mAh', value: ([, v]) => v, render: ([, v]) => mah(v) },
        { label: '', render: ([, v]) => bar([{ value: v ?? 0, cls: 'one' }], max) },
      ],
      items,
    ),
  );
}

function renderApps(report) {
  const max = Math.max(...report.apps.map((a) => a.mah), 1);
  const total = report.stats.dischargeMah;
  const legend = el('div', { class: 'legend' }, ...STATE_SEGMENTS.map((s) => el('span', {}, el('i', { style: `background: var(--${s.cls === 'bg' ? 'bg-state' : s.cls})` }), s.label)));
  $('apps').replaceChildren(
    legend,
    sortableTable(
      [
        { label: 'App', value: (a) => a.name, cls: 'name', render: (a) => el('span', { title: `UID ${a.uid}` }, a.name) },
        { label: 'mAh', value: (a) => a.mah, render: (a) => a.mah.toFixed(1) },
        { label: 'Share', value: (a) => a.mah, render: (a) => fmtPct(pctOf(a.mah, total)) },
        ...STATE_SEGMENTS.map((s) => ({ label: s.label.replace('Foreground service', 'FGS').replace('Foreground', 'FG').replace('Background', 'BG'), value: (a) => a[s.key], render: (a) => a[s.key].toFixed(1) })),
        { label: '', render: (a) => bar(STATE_SEGMENTS.map((s) => ({ value: a[s.key], cls: s.cls })), max) },
      ],
      report.apps,
      { initialSort: 1 },
    ),
  );
}

function timedTable(entries, nameCol) {
  if (entries.length === 0) return el('p', { class: 'muted' }, 'None recorded.');
  const max = Math.max(...entries.map((e) => e.durationMs), 1);
  return sortableTable(
    [
      nameCol,
      { label: 'Time', value: (e) => e.durationMs, render: (e) => formatDuration(e.durationMs) },
      { label: 'Count', value: (e) => e.count },
      { label: '', render: (e) => bar([{ value: e.durationMs, cls: 'one' }], max) },
    ],
    entries,
    { initialSort: 1 },
  );
}

function renderWakelocks(report) {
  $('wakelocks').replaceChildren(
    timedTable(report.wakeLocks, {
      label: 'App / tag',
      value: (w) => `${w.app} ${w.name}`,
      cls: 'name',
      render: (w) => el('span', {}, el('strong', {}, w.app), el('br'), el('span', { class: 'muted' }, w.name)),
    }),
  );
  $('kernel').replaceChildren(timedTable(report.kernelWakeLocks, { label: 'Name', value: (w) => w.name, cls: 'name' }));
  $('wakeups').replaceChildren(timedTable(report.wakeupReasons, { label: 'Reason', value: (w) => w.name, cls: 'name' }));
}

function render(report) {
  renderOverview(report);
  renderTimeline(report.history);
  renderComponents(report);
  renderRadio(report);
  renderApps(report);
  renderWakelocks(report);
  $('report').hidden = false;
  document.body.classList.add('loaded');
}

function setStatus(text, isError = false) {
  const status = $('status');
  status.textContent = text;
  status.classList.toggle('error', isError);
}

async function load(file) {
  setStatus(`Reading ${file.name}…`);
  try {
    const started = performance.now();
    const report = parseBatteryStats(await file.text());
    render(report);
    setStatus(`${file.name} · parsed in ${Math.round(performance.now() - started)} ms`);
  } catch (err) {
    $('report').hidden = true;
    setStatus(`Could not read ${file.name}: ${err.message}`, true);
  }
}

$('file').addEventListener('change', (e) => {
  const [file] = e.target.files;
  if (file) load(file);
});

const drop = $('drop');
for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  document.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'drop' || e.target === drop) drop.classList.remove('over');
  });
}
document.addEventListener('drop', (e) => {
  const [file] = e.dataTransfer.files;
  if (file) load(file);
});
