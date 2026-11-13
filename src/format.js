const HOUR_MS = 3_600_000;

export function formatDuration(ms) {
  if (ms === null) return 'n/a';
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return `${Math.round(ms / 1000)}s`;
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

const mah = (v) => (v === null ? 'n/a' : `${Math.round(v)} mAh`);
const pct = (part, whole) => (part === null || !whole ? '' : ` (${((part / whole) * 100).toFixed(1)}%)`);
const rate = (mahValue, ms) =>
  mahValue === null || !ms ? 'n/a' : `${(mahValue / (ms / HOUR_MS)).toFixed(0)} mAh/h`;
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clock = (t) => new Date(t).toISOString().slice(5, 16).replace('T', ' ');
const share = (part, whole) => pct(part, whole).trim().replace(/[()]/g, '');

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows
    .map((r) => '  ' + r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  '))
    .join('\n');
}

function kv(pairs) {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join('\n');
}

export function formatSummary(report, { top = 10 } = {}) {
  const { stats: s, history: h, dischargeSteps: steps, radio } = report;
  const out = [];
  const section = (title, body) => {
    if (body) out.push(`${title}\n${'-'.repeat(title.length)}\n${body}\n`);
  };

  const screenOn = s.screenOnMs;
  section(
    'Overview (since last charge)',
    kv([
      ['Started', s.startClockTime ?? 'n/a'],
      ['Battery capacity', `${mah(s.estimatedCapacityMah)} estimated, ${mah(s.learnedCapacityMah)} learned`],
      ['Time on battery', formatDuration(s.timeOnBatteryMs)],
      ['Screen on', `${formatDuration(screenOn)}${pct(screenOn, s.timeOnBatteryMs)}`],
      ['Screen off', `${formatDuration(s.screenOffOnBatteryMs)}${pct(s.screenOffOnBatteryMs, s.timeOnBatteryMs)}`],
      [
        'Battery used',
        s.dischargedPercentLow === null
          ? 'n/a'
          : `${s.dischargedPercentLow}-${s.dischargedPercentHigh}% (screen on ${s.dischargedPercentScreenOn}%, off ${s.dischargedPercentScreenOff}%)`,
      ],
      ['Total discharge', `${mah(s.dischargeMah)} (avg ${rate(s.dischargeMah, s.timeOnBatteryMs)})`],
      ['Screen-on drain', `${mah(s.screenOnDischargeMah)} (avg ${rate(s.screenOnDischargeMah, screenOn)})`],
      ['Screen-off drain', `${mah(s.screenOffDischargeMah)} (avg ${rate(s.screenOffDischargeMah, s.screenOffOnBatteryMs)})`],
      ['Deep doze drain', mah(s.deepDozeDischargeMah)],
      ['Wakelocks', `full ${formatDuration(s.fullWakelockMs)}, partial ${formatDuration(s.partialWakelockMs)}`],
      ...(s.chargeTimeRemainingMs !== null ? [['Charge time remaining', formatDuration(s.chargeTimeRemainingMs)]] : []),
      ...(s.batteryTimeRemainingMs !== null ? [['Battery time remaining', formatDuration(s.batteryTimeRemainingMs)]] : []),
    ]),
  );

  if (h) {
    section(
      'Battery history',
      kv([
        ['Window', `${h.start} -> ${h.end}`],
        ['Level', `${h.startLevel}% -> ${h.endLevel}% (min ${h.minLevel}%, max ${h.maxLevel}%)`],
        ...(h.maxTempC !== null ? [['Temperature', `${h.minTempC}°C - ${h.maxTempC}°C`]] : []),
        ...(h.maxVoltMv !== null ? [['Voltage', `${h.minVoltMv} - ${h.maxVoltMv} mV`]] : []),
        ['Status changes', h.statusChanges.map((c) => `${c.time} ${c.status} @${c.level}%`).join('\n' + ' '.repeat(18))],
      ]),
    );
  }

  if (steps.count > 0) {
    section(
      'Time per 1% drop',
      kv([
        ['Overall', formatDuration(steps.avgMsPerPercent)],
        ['Screen on', formatDuration(steps.avgMsPerPercentScreenOn)],
        ['Screen off', formatDuration(steps.avgMsPerPercentScreenOff)],
        ['Samples', String(steps.count)],
      ]),
    );
  }

  formatSleep(report.sleep, top, section);

  const total = s.dischargeMah;
  if (report.components.length > 0) {
    section(
      'Power use by component',
      table([
        ['Component', 'mAh', 'Share'],
        ...report.components
          .slice(0, top)
          .map((c) => [c.name, c.mah.toFixed(1), share(c.mah, total)]),
      ]),
    );
  }

  if (report.apps.length > 0) {
    section(
      `Top ${top} apps by power`,
      table([
        ['App', 'mAh', 'fg', 'bg', 'fgs', 'cached'],
        ...report.apps
          .slice(0, top)
          .map((a) => [
            truncate(a.name, 45),
            a.mah.toFixed(1),
            a.fgMah.toFixed(1),
            a.bgMah.toFixed(1),
            a.fgsMah.toFixed(1),
            a.cachedMah.toFixed(1),
          ]),
      ]),
    );
  }

  section(
    'Radio drain',
    kv([
      ['Wi-Fi', mah(radio.wifiMah)],
      ['Cellular', mah(radio.cellularMah)],
      ['GPS', mah(radio.gpsMah)],
    ]),
  );

  const timed = (title, entries, label) => {
    if (entries.length === 0) return;
    section(
      title,
      table([
        ['Name', 'Time', 'Count'],
        ...entries.slice(0, top).map((e) => [truncate(label(e), 70), formatDuration(e.durationMs), String(e.count)]),
      ]),
    );
  };
  timed(`Top ${top} partial wake locks`, report.wakeLocks, (w) => `${w.app}: ${w.name}`);
  timed(`Top ${top} kernel wake locks`, report.kernelWakeLocks, (w) => w.name);
  timed(`Top ${top} wakeup reasons`, report.wakeupReasons, (w) => w.name);

  return out.join('\n');
}

function formatSleep(sleep, top, section) {
  const t = sleep.totals;
  const idle = (mode) =>
    mode === null
      ? 'n/a'
      : `${formatDuration(mode.durationMs)}, entered ${mode.count}x` +
        (mode.longestMs === null ? '' : `, longest ${formatDuration(mode.longestMs)}`);
  section(
    'Sleep (screen off, on battery)',
    kv([
      ['Screen-off time', formatDuration(sleep.screenOffMs)],
      ['Drain', `${mah(sleep.screenOffDischargeMah)} (avg ${sleep.mahPerHour === null ? 'n/a' : `${sleep.mahPerHour.toFixed(0)} mAh/h`})`],
      ['Deep doze', `${idle(sleep.deepIdle)}; ${mah(sleep.deepDozeDischargeMah)}`],
      ['Light doze', `${idle(sleep.lightIdle)}; ${mah(sleep.lightDozeDischargeMah)}`],
      ...(t === null
        ? []
        : [
            ['Level drop', `${t.levelDrop}% (${t.percentPerHour.toFixed(2)}%/h)`],
            ['CPU awake', `${formatDuration(t.awakeMs)}${pct(t.awakeMs, t.durationMs)} of screen-off time`],
            ['GPS on', `${formatDuration(t.gpsMs)}${pct(t.gpsMs, t.durationMs)}`],
            ['In deep doze', `${formatDuration(t.deepIdleMs)}${pct(t.deepIdleMs, t.durationMs)}`],
            ['Wakeups', `${t.wakeups} (${t.wakeupsPerHour.toFixed(1)}/h)`],
          ]),
    ]),
  );

  if (sleep.sessions.length > 0) {
    section(
      'Sleep sessions (screen off >= 10m)',
      table([
        ['Start', 'Length', 'Level', '%/h', 'Awake', 'GPS', 'Doze', 'Wakeups/h'],
        ...sleep.sessions.map((p) => [
          clock(p.start),
          formatDuration(p.durationMs),
          `${p.startLevel}->${p.endLevel}%`,
          p.percentPerHour.toFixed(1),
          share(p.awakeMs, p.durationMs),
          share(p.gpsMs, p.durationMs),
          share(p.deepIdleMs + p.lightIdleMs, p.durationMs),
          p.wakeupsPerHour.toFixed(0),
        ]),
      ]),
    );
  }

  if (sleep.components.length > 0) {
    section(
      'Screen-off power by component',
      table([
        ['Component', 'mAh', 'Share'],
        ...sleep.components
          .slice(0, top)
          .map((c) => [c.name, c.mah.toFixed(1), share(c.mah, sleep.screenOffDischargeMah)]),
      ]),
    );
  }

  if (sleep.apps.length > 0) {
    section(
      `Top ${top} apps while screen off`,
      table([
        ['App', 'mAh', 'Biggest consumers'],
        ...sleep.apps.slice(0, top).map((a) => [
          truncate(a.name, 45),
          a.mah.toFixed(1),
          Object.entries(a.breakdown)
            .sort((x, y) => y[1] - x[1])
            .slice(0, 3)
            .map(([k, v]) => `${k} ${v.toFixed(1)}`)
            .join(', '),
        ]),
      ]),
    );
  }

  if (t !== null && t.topWakeLockHolders.length > 0) {
    section(
      `Top ${top} wake lock holders while screen off (history only records the first holder)`,
      table([
        ['App', 'Held', 'Count', 'Main tag'],
        ...t.topWakeLockHolders
          .slice(0, top)
          .map((w) => [truncate(w.name, 40), formatDuration(w.durationMs), String(w.count), truncate(w.topTag, 50)]),
      ]),
    );
  }

  if (t !== null && t.topWakeReasons.length > 0) {
    section(
      `Top ${top} wakeup reasons while screen off`,
      table([
        ['Reason', 'Count'],
        ...t.topWakeReasons.slice(0, top).map((r) => [truncate(r.name, 70), String(r.count)]),
      ]),
    );
  }
}
