/** The live log page: a static shell that renders entries from /logs/stream. */
export const LOGS_PAGE = /* html */ `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LLM Gateway — логи</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #fff; --text: #1d1f23; --muted: #6b7280; --line: #e5e7eb;
    --ok: #15803d; --ok-bg: #dcfce7; --warn: #b45309; --warn-bg: #fef3c7;
    --err: #b91c1c; --err-bg: #fee2e2; --run: #1d4ed8; --run-bg: #dbeafe; --flash: #fff7d6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --panel: #171a21; --text: #e6e8ec; --muted: #8b93a1; --line: #262b35;
      --ok: #4ade80; --ok-bg: #12301f; --warn: #fbbf24; --warn-bg: #3a2c0c;
      --err: #f87171; --err-bg: #3b1515; --run: #93c5fd; --run-bg: #172a4a; --flash: #2b2a17;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 24px; padding: 16px 24px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 1; }
  h1 { font-size: 18px; margin: 0; font-weight: 600; }
  .conn { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--err); }
  .conn.live .dot { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
  .stats { display: flex; gap: 20px; margin-left: auto; flex-wrap: wrap; }
  .stat { display: flex; flex-direction: column; align-items: flex-end; }
  .stat b { font-size: 18px; font-variant-numeric: tabular-nums; }
  .stat span { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  main { padding: 16px 24px 40px; }
  .wrap { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 900px; }
  th { text-align: left; font-weight: 500; font-size: 12px; color: var(--muted); padding: 10px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  td { padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  tr.flash td { animation: flash 1.2s ease-out; }
  @keyframes flash { from { background: var(--flash); } to { background: transparent; } }
  .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sub { color: var(--muted); font-size: 12px; }
  .req { max-width: 420px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .b-ok { color: var(--ok); background: var(--ok-bg); }
  .b-warn { color: var(--warn); background: var(--warn-bg); }
  .b-err { color: var(--err); background: var(--err-bg); }
  .b-run { color: var(--run); background: var(--run-bg); }
  .b-queue { color: var(--muted); background: var(--line); }
  .empty { padding: 40px; text-align: center; color: var(--muted); }
  @media (max-width: 640px) { header, main { padding-left: 16px; padding-right: 16px; } .stats { margin-left: 0; } }
</style>
</head>
<body>
<header>
  <h1>LLM Gateway — логи</h1>
  <span class="conn" id="conn"><span class="dot"></span><span id="conn-text">подключение…</span></span>
  <div class="stats">
    <div class="stat"><b id="s-active">0</b><span>генерация</span></div>
    <div class="stat"><b id="s-queued">0</b><span>в очереди</span></div>
    <div class="stat"><b id="s-total">0</b><span>запросов</span></div>
    <div class="stat"><b id="s-errors">0</b><span>отказов</span></div>
    <div class="stat"><b id="s-avg">—</b><span>сред. время</span></div>
  </div>
</header>
<main>
  <div class="wrap">
    <table>
      <thead><tr>
        <th>Время</th><th>Клиент</th><th>Запрос</th><th>Ответ</th><th>Размер ответа</th><th>Длительность</th>
      </tr></thead>
      <tbody id="rows"><tr><td colspan="6" class="empty">Запросов пока нет — отправьте сообщение из приложения</td></tr></tbody>
    </table>
  </div>
</main>
<script>
const entries = new Map();
const rows = document.getElementById('rows');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const sec = (ms) => ms == null ? '—' : ms < 1000 ? ms + ' мс' : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' с';
const bytes = (n) => n == null ? '' : n < 1024 ? n + ' Б' : (n / 1024).toFixed(1) + ' КБ';
const time = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const OUTCOMES = {
  ok: 'OK', invalid_api_key: 'нет ключа', rate_limit_exceeded: 'rate limit', server_busy: 'очередь полна',
  context_length_exceeded: 'контекст превышен', client_closed: 'клиент ушёл', timeout: 'таймаут',
  model_not_found: 'нет модели', invalid_request: 'неверный запрос', request_too_large: 'слишком большой',
};

function statusCell(e) {
  if (e.state === 'queued') return '<span class="badge b-queue">в очереди</span>';
  if (e.state === 'generating') return '<span class="badge b-run">генерация…</span>';
  const label = OUTCOMES[e.outcome] ?? e.outcome ?? '';
  const cls = e.status < 300 ? 'b-ok' : e.status === 429 || e.status === 503 || e.outcome === 'client_closed' ? 'b-warn' : 'b-err';
  const reason = e.outcome === 'ok' && e.finishReason === 'length' ? '<div class="sub">обрезан по max_tokens</div>' : '';
  return '<span class="badge ' + cls + '">' + (e.status ?? '') + ' ' + esc(label) + '</span>' + reason +
    (e.error ? '<div class="sub">' + esc(e.error) + '</div>' : '');
}

function sizeCell(e) {
  if (e.state === 'queued') return '<span class="sub">—</span>';
  const tokens = e.completionTokens != null ? e.completionTokens + ' ток.' : '';
  const main = e.chars ? e.chars + ' симв.' : tokens || (e.state === 'done' ? '0' : '…');
  const sub = [e.chars ? tokens : '', bytes(e.bytes), e.promptTokens ? 'вход ' + e.promptTokens + ' ток.' : ''].filter(Boolean).join(' · ');
  return '<div class="num">' + main + '</div>' + (sub ? '<div class="sub num">' + sub + '</div>' : '');
}

function durationCell(e) {
  const total = e.state === 'done' ? e.durationMs : Date.now() - e.startedAt;
  const parts = [];
  if (e.queuedMs > 20) parts.push('очередь ' + sec(e.queuedMs));
  if (e.firstTokenMs != null) parts.push('1-й токен ' + sec(e.firstTokenMs));
  return '<div class="num"><b>' + sec(total) + '</b></div>' + (parts.length ? '<div class="sub num">' + parts.join(' · ') + '</div>' : '');
}

function rowHtml(e) {
  return '<td class="num">' + time(e.startedAt) + '</td>' +
    '<td><div>' + esc(e.device || e.client) + '</div>' + (e.device ? '<div class="sub">ключ: ' + esc(e.client) + '</div>' : '') + '</td>' +
    '<td><div class="req">' + esc(e.preview || '—') + '</div><div class="sub">' +
      [e.model, e.messages ? e.messages + ' сообщ.' : '', e.stream ? 'stream' : ''].filter(Boolean).map(esc).join(' · ') + '</div></td>' +
    '<td>' + statusCell(e) + '</td><td>' + sizeCell(e) + '</td><td>' + durationCell(e) + '</td>';
}

function render(e, isNew) {
  let tr = document.getElementById('r-' + e.id);
  if (!tr) {
    if (rows.querySelector('.empty')) rows.innerHTML = '';
    tr = document.createElement('tr');
    tr.id = 'r-' + e.id;
    rows.prepend(tr);
  }
  tr.innerHTML = rowHtml(e);
  if (isNew) { tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash'); }
}

function stats() {
  const all = [...entries.values()];
  const done = all.filter((e) => e.state === 'done');
  const ok = done.filter((e) => e.status === 200);
  document.getElementById('s-active').textContent = all.filter((e) => e.state === 'generating').length;
  document.getElementById('s-queued').textContent = all.filter((e) => e.state === 'queued').length;
  document.getElementById('s-total').textContent = all.length;
  document.getElementById('s-errors').textContent = done.length - ok.length;
  document.getElementById('s-avg').textContent = ok.length ? sec(Math.round(ok.reduce((s, e) => s + e.durationMs, 0) / ok.length)) : '—';
}

function apply(e) {
  const isNew = !entries.has(e.id) || (entries.get(e.id).state !== 'done' && e.state === 'done');
  entries.set(e.id, e);
  render(e, isNew);
  stats();
}

const key = new URLSearchParams(location.search).get('key');
function connect() {
  const conn = document.getElementById('conn');
  const es = new EventSource('logs/stream' + (key ? '?key=' + encodeURIComponent(key) : ''));
  es.addEventListener('snapshot', (m) => {
    entries.clear();
    rows.innerHTML = '';
    const list = JSON.parse(m.data);
    if (!list.length) rows.innerHTML = '<tr><td colspan="6" class="empty">Запросов пока нет — отправьте сообщение из приложения</td></tr>';
    list.forEach((e) => { entries.set(e.id, e); render(e, false); });
    stats();
  });
  es.onmessage = (m) => apply(JSON.parse(m.data));
  es.onopen = () => { conn.classList.add('live'); document.getElementById('conn-text').textContent = 'в эфире'; };
  es.onerror = () => { conn.classList.remove('live'); document.getElementById('conn-text').textContent = 'переподключение…'; };
}
connect();
// Ticks the running clock of requests still in flight.
setInterval(() => entries.forEach((e) => { if (e.state !== 'done') render(e, false); }), 100);
</script>
</body>
</html>`;
