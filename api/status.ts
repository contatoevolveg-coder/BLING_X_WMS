import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../lib/supabase';
import { isDashAuthenticated } from '../lib/auth';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!isDashAuthenticated(req)) {
    res.redirect(302, '/api/admin/login?next=/api/status');
    return;
  }

  const db = getSupabase();
  const now = new Date();

  const [tokenRes, eventsRes, mappingsRes, snapshotsRes, baixasRes, settingsRes] =
    await Promise.all([
      db.from('bling_tokens').select('expires_at, updated_at, scope').eq('singleton_key', 'default').single(),
      db.from('webhook_events').select('*').order('created_at', { ascending: false }).limit(100),
      db.from('product_mappings').select('*').order('created_at', { ascending: false }),
      db.from('stock_snapshots').select('*').order('snapshot_at', { ascending: false }).limit(200),
      db.from('processed_baixas').select('*').order('created_at', { ascending: false }).limit(100),
      db.from('system_settings').select('*'),
    ]);

  const token     = tokenRes.data;
  const events    = eventsRes.data   ?? [];
  const mappings  = mappingsRes.data  ?? [];
  const snapshots = snapshotsRes.data ?? [];
  const baixas    = baixasRes.data    ?? [];
  const settings  = settingsRes.data  ?? [];

  const tokenExpiry   = token ? new Date(token.expires_at) : null;
  const tokenValid    = tokenExpiry ? tokenExpiry > now : false;
  const tokenMins     = tokenExpiry ? Math.round((tokenExpiry.getTime() - now.getTime()) / 60000) : null;

  const counts = events.reduce<Record<string, number>>((a, e) => { a[e.status] = (a[e.status] ?? 0) + 1; return a; }, {});
  const pending  = counts['pending']    ?? 0;
  const done     = counts['done']       ?? 0;
  const failed   = (counts['failed']   ?? 0) + (counts['dlq'] ?? 0);
  const quar     = counts['quarantine'] ?? 0;

  const blingEvents = events.filter(e => e.source === 'bling');
  const wmsEvents   = events.filter(e => e.source === 'wms');

  const fmt = (d: string) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const fmtDate = (d: string) => new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const sc = (s: string) => ({ done: '#22c55e', pending: '#f59e0b', processing: '#3b82f6', failed: '#ef4444', dlq: '#dc2626', quarantine: '#a855f7' }[s] ?? '#6b7280');

  const statusBadge = (s: string) => {
    const colors: Record<string, string> = { done: '#14532d:#86efac', pending: '#78350f:#fde68a', processing: '#1e3a5f:#93c5fd', failed: '#7f1d1d:#fca5a5', dlq: '#450a0a:#fca5a5', quarantine: '#3b0764:#d8b4fe' };
    const [bg, fg] = (colors[s] ?? '#1e293b:#94a3b8').split(':');
    return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">${s}</span>`;
  };

  const srcBadge = (s: string) => s === 'bling'
    ? `<span style="background:#1a1e3a;color:#a78bfa;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">BLING</span>`
    : `<span style="background:#1e3a5f;color:#60a5fa;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">WMS</span>`;

  const requeueBtn = (id: string) =>
    `<button onclick="requeue('${id}')" style="background:#1e3a5f;color:#93c5fd;border:none;border-radius:4px;padding:3px 8px;font-size:.68rem;cursor:pointer;font-weight:600">↩ Reprocessar</button>`;

  const evRows = (arr: typeof events, showAction = false) => arr.length === 0
    ? `<tr><td colspan="${showAction ? 8 : 7}" style="text-align:center;color:#475569;padding:24px;font-style:italic">Nenhum evento encontrado</td></tr>`
    : arr.map(e => `<tr class="ev-row" data-status="${e.status}" data-source="${e.source}">
        <td>${srcBadge(e.source)}</td>
        <td style="font-family:monospace;font-size:.75rem">${e.event_type}</td>
        <td>${statusBadge(e.status)}</td>
        <td style="font-size:.75rem">${e.retry_count}</td>
        <td style="font-size:.75rem;white-space:nowrap">${fmt(e.created_at)}</td>
        <td style="font-size:.75rem;white-space:nowrap">${e.processed_at ? fmt(e.processed_at) : '—'}</td>
        <td style="font-size:.72rem;color:#ef4444;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(e.error ?? '').replace(/"/g, '&quot;')}">${e.error ?? '—'}</td>
        ${showAction ? `<td>${['dlq','quarantine','failed'].includes(e.status) ? requeueBtn(e.id) : '—'}</td>` : ''}
      </tr>`).join('');

  const mapRows = mappings.length === 0
    ? `<tr><td colspan="6" style="text-align:center;color:#475569;padding:24px;font-style:italic">Nenhum mapeamento cadastrado. Use o formulário acima para adicionar.</td></tr>`
    : mappings.map((m: Record<string, unknown>) => `<tr>
        <td style="font-family:monospace">${m['wms_code']}</td>
        <td style="font-family:monospace">${m['bling_sku']}</td>
        <td style="font-family:monospace;font-size:.75rem">${m['bling_product_id']}</td>
        <td>${m['active'] ? `<span style="background:#14532d;color:#86efac;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">Ativo</span>` : `<span style="background:#7f1d1d;color:#fca5a5;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">Inativo</span>`}</td>
        <td style="font-size:.75rem">${fmt(m['created_at'] as string)}</td>
        <td style="white-space:nowrap">
          <button onclick="toggleMapping('${m['id']}',${m['active']})" style="background:#0f172a;border:1px solid #334155;color:#94a3b8;border-radius:4px;padding:3px 8px;font-size:.68rem;cursor:pointer;margin-right:4px">${m['active'] ? 'Desativar' : 'Ativar'}</button>
          <button onclick="deleteMapping('${m['id']}')" style="background:#7f1d1d;color:#fca5a5;border:none;border-radius:4px;padding:3px 8px;font-size:.68rem;cursor:pointer">🗑</button>
        </td>
      </tr>`).join('');

  const snapRows = snapshots.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:#475569;padding:24px;font-style:italic">Nenhum snapshot de estoque ainda</td></tr>`
    : snapshots.map((s: Record<string, unknown>) => `<tr>
        <td>${s['source'] === 'bling' ? srcBadge('bling') : srcBadge('wms')}</td>
        <td style="font-family:monospace">${s['product_code']}</td>
        <td style="font-size:.9rem;font-weight:600;color:${(s['quantity'] as number) > 0 ? '#86efac' : '#fca5a5'}">${s['quantity']}</td>
        <td style="font-size:.75rem">${fmt(s['snapshot_at'] as string)}</td>
      </tr>`).join('');

  const baixaRows = baixas.length === 0
    ? `<tr><td colspan="3" style="text-align:center;color:#475569;padding:24px;font-style:italic">Nenhuma baixa processada ainda</td></tr>`
    : baixas.map((b: Record<string, unknown>) => `<tr>
        <td style="font-family:monospace">${b['wms_code']}</td>
        <td style="font-family:monospace;font-size:.75rem">${b['event_id']}</td>
        <td style="font-size:.75rem">${fmt(b['created_at'] as string)}</td>
      </tr>`).join('');

  const settingsRows = settings.length === 0
    ? `<tr><td colspan="3" style="text-align:center;color:#475569;padding:24px;font-style:italic">Nenhuma configuração salva</td></tr>`
    : settings.map((s: Record<string, unknown>) => `<tr>
        <td style="font-family:monospace">${s['key']}</td>
        <td style="font-family:monospace;font-size:.75rem;color:#94a3b8">${String(s['key']).toLowerCase().includes('key') || String(s['key']).toLowerCase().includes('token') ? '••••••••••••••••' : s['value']}</td>
        <td style="font-size:.75rem">${fmt(s['updated_at'] as string)}</td>
      </tr>`).join('');

  // Group stock by product for "itens" view
  const stockByProduct: Record<string, { bling?: number; wms?: number; code: string }> = {};
  for (const s of snapshots) {
    const sp = s as Record<string, unknown>;
    const code = String(sp['product_code']);
    if (!stockByProduct[code]) stockByProduct[code] = { code };
    if (sp['source'] === 'bling') stockByProduct[code].bling = sp['quantity'] as number;
    else stockByProduct[code].wms = sp['quantity'] as number;
  }
  const stockItems = Object.values(stockByProduct);
  const stockRows = stockItems.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:#475569;padding:24px;font-style:italic">Nenhum dado de estoque. O cron de reconciliação populará esta tabela.</td></tr>`
    : stockItems.map(s => {
        const diff = s.bling !== undefined && s.wms !== undefined ? s.bling - s.wms : null;
        const diffColor = diff === null ? '#64748b' : diff === 0 ? '#22c55e' : '#ef4444';
        return `<tr>
          <td style="font-family:monospace">${s.code}</td>
          <td style="text-align:center;font-weight:600;color:${s.bling !== undefined ? '#86efac' : '#475569'}">${s.bling ?? '—'}</td>
          <td style="text-align:center;font-weight:600;color:${s.wms !== undefined ? '#60a5fa' : '#475569'}">${s.wms ?? '—'}</td>
          <td style="text-align:center;font-weight:700;color:${diffColor}">${diff !== null ? (diff > 0 ? `+${diff}` : diff) : '—'}</td>
        </tr>`;
      }).join('');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SyncStock — Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
.topbar{background:#1e293b;border-bottom:1px solid #334155;padding:14px 28px;display:flex;align-items:center;justify-content:space-between}
.logo{font-size:1.1rem;font-weight:700;color:#f8fafc;display:flex;align-items:center;gap:8px}
.logo span{color:#f59e0b}
.topright{display:flex;align-items:center;gap:12px;font-size:.78rem;color:#64748b}
.badge-ok{background:#14532d;color:#86efac;padding:3px 10px;border-radius:99px;font-size:.72rem;font-weight:600}
.badge-err{background:#7f1d1d;color:#fca5a5;padding:3px 10px;border-radius:99px;font-size:.72rem;font-weight:600}
a.refresh-btn{background:#1e3a5f;color:#93c5fd;border:none;padding:5px 14px;border-radius:6px;font-size:.75rem;cursor:pointer;text-decoration:none;font-weight:600}
a.refresh-btn:hover{background:#1d4ed8;color:#fff}
.tabs{display:flex;gap:0;background:#1e293b;border-bottom:1px solid #334155;padding:0 24px;overflow-x:auto}
.tab{padding:14px 20px;font-size:.82rem;font-weight:600;color:#64748b;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;user-select:none}
.tab:hover{color:#94a3b8}
.tab.active{color:#f8fafc;border-bottom-color:#3b82f6}
.tab-content{display:none;padding:24px}
.tab-content.active{display:block}
.grid4{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:18px}
.card-label{font-size:.68rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
.card-val{font-size:2rem;font-weight:700;color:#f8fafc;line-height:1}
.card-sub{font-size:.72rem;color:#64748b;margin-top:6px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle}
section{background:#1e293b;border:1px solid #334155;border-radius:10px;margin-bottom:20px;overflow:hidden}
.sec-head{padding:14px 18px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #334155}
.sec-title{font-size:.85rem;font-weight:600;color:#94a3b8}
.sec-meta{font-size:.72rem;color:#475569}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:.68rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.06em;padding:8px 16px;border-bottom:1px solid #334155}
td{padding:9px 16px;border-bottom:1px solid #1a2336;font-size:.8rem;color:#cbd5e1;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#243144}
.flow{display:flex;align-items:stretch;gap:0;flex-wrap:wrap;margin-bottom:20px}
.fstep{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px 16px;font-size:.75rem;flex:1;min-width:130px}
.fstep strong{display:block;color:#e2e8f0;font-size:.78rem;margin-bottom:3px}
.fstep span{color:#64748b}
.farrow{color:#334155;font-size:1.4rem;padding:0 6px;display:flex;align-items:center;flex-shrink:0}
.filter-row{display:flex;gap:8px;padding:12px 16px;background:#172033;border-bottom:1px solid #334155;flex-wrap:wrap}
.filter-btn{background:#0f172a;border:1px solid #334155;color:#64748b;padding:4px 12px;border-radius:99px;font-size:.72rem;cursor:pointer;font-weight:600}
.filter-btn.on{border-color:#3b82f6;color:#93c5fd;background:#1e3a5f}
input.search{background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:4px 12px;border-radius:6px;font-size:.75rem;outline:none;width:200px}
input.search:focus{border-color:#3b82f6}
.stat-mini{display:flex;gap:12px;flex-wrap:wrap}
.sm{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 16px;text-align:center;min-width:90px}
.sm-n{font-size:1.5rem;font-weight:700}
.sm-l{font-size:.65rem;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
.empty-msg{color:#475569;font-style:italic;text-align:center;padding:32px;font-size:.85rem}
</style>
</head>
<body>

<div class="topbar">
  <div class="logo"><span>⚡</span> SyncStock <span style="font-weight:400;color:#475569;font-size:.85rem;margin-left:4px">· Dashboard</span></div>
  <div class="topright">
    ${tokenValid ? `<span class="badge-ok">✓ Token Bling válido</span>` : `<span class="badge-err">✗ Token expirado</span>`}
    <span>${now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</span>
    <a href="/api/status" class="refresh-btn">↻ Atualizar</a>
  </div>
</div>

<div class="tabs">
  <div class="tab active" onclick="showTab('overview')">📊 Visão Geral</div>
  <div class="tab" onclick="showTab('events')">📬 Fila de Eventos <span id="ev-badge" style="background:#f59e0b;color:#000;border-radius:99px;padding:1px 7px;font-size:.68rem;margin-left:4px">${pending}</span></div>
  <div class="tab" onclick="showTab('estoque')">📦 Estoque</div>
  <div class="tab" onclick="showTab('mappings')">🔗 Mapeamentos</div>
  <div class="tab" onclick="showTab('baixas')">✅ Baixas Processadas</div>
  <div class="tab" onclick="showTab('config')">⚙️ Configuração</div>
</div>

<!-- ═══════════════════════════════════════════ VISÃO GERAL ═══ -->
<div id="tab-overview" class="tab-content active">

  <div class="grid4">
    <div class="card">
      <div class="card-label">Token Bling OAuth</div>
      ${tokenValid ? `<div style="margin-bottom:6px"><span class="badge-ok">✓ Válido</span></div>` : `<div style="margin-bottom:6px"><span class="badge-err">✗ Expirado</span></div>`}
      <div class="card-sub">${tokenMins !== null ? (tokenMins > 0 ? `Expira em ${tokenMins} min` : `Expirou há ${Math.abs(tokenMins)} min`) : 'Não encontrado'}</div>
      ${token ? `<div class="card-sub" style="margin-top:3px">Atualizado: ${fmt(token.updated_at)}</div>` : ''}
    </div>
    <div class="card">
      <div class="card-label">Fila — Pendentes</div>
      <div class="card-val" style="color:${pending > 0 ? '#fde68a' : '#86efac'}">${pending}</div>
      <div class="card-sub">${events.length} total · ${done} concluídos · ${failed} falhas</div>
    </div>
    <div class="card">
      <div class="card-label">Eventos Bling / WMS</div>
      <div class="card-val">${blingEvents.length} <span style="font-size:1rem;color:#64748b">/</span> ${wmsEvents.length}</div>
      <div class="card-sub">Bling · WMS Smartgo</div>
    </div>
    <div class="card">
      <div class="card-label">Mapeamentos Ativos</div>
      <div class="card-val">${mappings.filter((m: Record<string,unknown>) => m['active']).length}</div>
      <div class="card-sub">${mappings.length} total · ${baixas.length} baixas</div>
    </div>
  </div>

  <section>
    <div class="sec-head"><span class="sec-title">Fluxo 1 — WMS → Bling (Baixa de Estoque)</span></div>
    <div style="padding:16px">
      <div class="flow">
        <div class="fstep"><strong>Smartgo WMS</strong><span>Expedição finalizada → webhook POST</span></div>
        <div class="farrow">→</div>
        <div class="fstep"><strong>Fila Supabase</strong><span>Evento salvo como <em>pending</em></span></div>
        <div class="farrow">→</div>
        <div class="fstep"><strong>Worker (Cron)</strong><span>Processa lotes de 10 eventos</span></div>
        <div class="farrow">→</div>
        <div class="fstep"><strong>Bling ERP</strong><span>Baixa de estoque via API</span></div>
      </div>
    </div>
  </section>

  <section>
    <div class="sec-head"><span class="sec-title">Fluxo 2 — Bling → WMS (Expedição)</span></div>
    <div style="padding:16px">
      <div class="flow">
        <div class="fstep"><strong>Bling ERP</strong><span>Pedido atualizado → webhook POST</span></div>
        <div class="farrow">→</div>
        <div class="fstep"><strong>Fila Supabase</strong><span>Evento salvo como <em>pending</em></span></div>
        <div class="farrow">→</div>
        <div class="fstep"><strong>Worker (Cron)</strong><span>Cria expedição no WMS</span></div>
        <div class="farrow">→</div>
        <div class="fstep"><strong>Smartgo WMS</strong><span>Ordem de separação criada</span></div>
      </div>
    </div>
  </section>

  <section>
    <div class="sec-head"><span class="sec-title">Últimos 5 Eventos</span><span class="sec-meta"><a href="#" onclick="showTab('events')" style="color:#3b82f6;text-decoration:none">Ver todos →</a></span></div>
    <table>
      <thead><tr><th>Origem</th><th>Tipo</th><th>Status</th><th>Recebido</th><th>Erro</th></tr></thead>
      <tbody>${evRows(events.slice(0, 5))}</tbody>
    </table>
  </section>
</div>

<!-- ═════════════════════════════════════════ FILA DE EVENTOS ═══ -->
<div id="tab-events" class="tab-content">
  <div style="margin-bottom:16px">
    <div class="stat-mini">
      <div class="sm"><div class="sm-n" style="color:#e2e8f0">${events.length}</div><div class="sm-l">Total</div></div>
      <div class="sm"><div class="sm-n" style="color:#fde68a">${pending}</div><div class="sm-l">Pending</div></div>
      <div class="sm"><div class="sm-n" style="color:#86efac">${done}</div><div class="sm-l">Done</div></div>
      <div class="sm"><div class="sm-n" style="color:#fca5a5">${failed}</div><div class="sm-l">Falha</div></div>
      <div class="sm"><div class="sm-n" style="color:#d8b4fe">${quar}</div><div class="sm-l">Quarentena</div></div>
    </div>
  </div>
  <section>
    <div class="filter-row">
      <span style="font-size:.75rem;color:#64748b;margin-right:4px">Status:</span>
      <button class="filter-btn on" onclick="filterEv(this,'all-status')">Todos</button>
      <button class="filter-btn" onclick="filterEv(this,'pending')">Pending</button>
      <button class="filter-btn" onclick="filterEv(this,'done')">Done</button>
      <button class="filter-btn" onclick="filterEv(this,'failed')">Failed</button>
      <button class="filter-btn" onclick="filterEv(this,'dlq')">DLQ</button>
      <button class="filter-btn" onclick="filterEv(this,'quarantine')">Quarentena</button>
      &nbsp;
      <span style="font-size:.75rem;color:#64748b;margin-right:4px">Origem:</span>
      <button class="filter-btn on" onclick="filterSrc(this,'all-src')">Todos</button>
      <button class="filter-btn" onclick="filterSrc(this,'bling')">Bling</button>
      <button class="filter-btn" onclick="filterSrc(this,'wms')">WMS</button>
    </div>
    <table id="ev-table">
      <thead><tr><th>Origem</th><th>Tipo</th><th>Status</th><th>Tentativas</th><th>Recebido</th><th>Processado</th><th>Erro</th><th>Ação</th></tr></thead>
      <tbody>${evRows(events, true)}</tbody>
    </table>
    ${events.length === 0 ? '' : `<div style="padding:10px 16px;font-size:.72rem;color:#475569;border-top:1px solid #334155">Mostrando ${events.length} evento(s) · máximo 100</div>`}
  </section>
</div>

<!-- ══════════════════════════════════════════════ ESTOQUE ═══ -->
<div id="tab-estoque" class="tab-content">
  <section>
    <div class="sec-head">
      <span class="sec-title">Comparativo de Estoque Bling × WMS</span>
      <span class="sec-meta">${stockItems.length} produto(s)</span>
    </div>
    <table>
      <thead><tr><th>Código Produto</th><th style="text-align:center">Qtd Bling</th><th style="text-align:center">Qtd WMS</th><th style="text-align:center">Diferença</th></tr></thead>
      <tbody>${stockRows}</tbody>
    </table>
    ${snapshots.length === 0 ? `` : `<div style="padding:10px 16px;font-size:.72rem;color:#475569;border-top:1px solid #334155">Dados do último cron de reconciliação · ${snapshots.length} registros</div>`}
  </section>

  <section>
    <div class="sec-head">
      <span class="sec-title">Snapshots de Estoque (histórico)</span>
      <span class="sec-meta">${snapshots.length} registro(s)</span>
    </div>
    <table>
      <thead><tr><th>Origem</th><th>Código</th><th>Quantidade</th><th>Capturado em</th></tr></thead>
      <tbody>${snapRows}</tbody>
    </table>
  </section>
</div>

<!-- ════════════════════════════════════════ MAPEAMENTOS ═══ -->
<div id="tab-mappings" class="tab-content">
  <section style="margin-bottom:16px">
    <div class="sec-head"><span class="sec-title">Novo Mapeamento</span></div>
    <div style="padding:16px;display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
      <div>
        <label style="display:block;font-size:.7rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">Código WMS</label>
        <input id="new-wms" class="search" placeholder="ex: PROD-001" style="width:160px">
      </div>
      <div>
        <label style="display:block;font-size:.7rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">SKU Bling</label>
        <input id="new-sku" class="search" placeholder="ex: SKU123" style="width:160px">
      </div>
      <div>
        <label style="display:block;font-size:.7rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">ID Produto Bling</label>
        <input id="new-pid" class="search" type="number" placeholder="ex: 12345678" style="width:160px">
      </div>
      <button onclick="addMapping()" style="background:#22c55e;color:#000;border:none;border-radius:6px;padding:8px 18px;font-size:.8rem;font-weight:700;cursor:pointer">+ Adicionar</button>
    </div>
    <div id="map-msg" style="display:none;padding:8px 16px;font-size:.78rem;border-top:1px solid #334155"></div>
  </section>
  <section>
    <div class="sec-head">
      <span class="sec-title">Mapeamentos WMS ↔ Bling</span>
      <span class="sec-meta">${mappings.length} total · ${mappings.filter((m: Record<string,unknown>) => m['active']).length} ativos</span>
    </div>
    <table>
      <thead><tr><th>Código WMS</th><th>SKU Bling</th><th>ID Produto Bling</th><th>Status</th><th>Cadastrado</th><th>Ações</th></tr></thead>
      <tbody>${mapRows}</tbody>
    </table>
  </section>
</div>

<!-- ══════════════════════════════════════ BAIXAS PROCESSADAS ═══ -->
<div id="tab-baixas" class="tab-content">
  <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:14px 18px;margin-bottom:16px;font-size:.8rem;color:#94a3b8">
    Registro de idempotência: cada item de expedição processado aparece aqui para evitar baixas duplicadas no Bling.
  </div>
  <section>
    <div class="sec-head">
      <span class="sec-title">Baixas Realizadas no Bling</span>
      <span class="sec-meta">${baixas.length} registro(s)</span>
    </div>
    <table>
      <thead><tr><th>Código WMS</th><th>ID do Evento</th><th>Processado em</th></tr></thead>
      <tbody>${baixaRows}</tbody>
    </table>
  </section>
</div>

<!-- ════════════════════════════════════════ CONFIGURAÇÃO ═══ -->
<div id="tab-config" class="tab-content">
  <section>
    <div class="sec-head">
      <span class="sec-title">Configurações do Sistema</span>
      <span class="sec-meta">${settings.length} chave(s)</span>
    </div>
    <table>
      <thead><tr><th>Chave</th><th>Valor</th><th>Atualizado</th></tr></thead>
      <tbody>${settingsRows}</tbody>
    </table>
  </section>

  <section>
    <div class="sec-head"><span class="sec-title">Endpoints da API</span></div>
    <table>
      <thead><tr><th>Método</th><th>Rota</th><th>Descrição</th></tr></thead>
      <tbody>
        <tr><td><span style="background:#14532d;color:#86efac;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">GET</span></td><td style="font-family:monospace">/api/auth/start</td><td>Inicia OAuth com o Bling</td></tr>
        <tr><td><span style="background:#14532d;color:#86efac;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">GET</span></td><td style="font-family:monospace">/api/auth/callback</td><td>Callback OAuth — salva tokens</td></tr>
        <tr><td><span style="background:#1e3a5f;color:#93c5fd;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">POST</span></td><td style="font-family:monospace">/api/webhooks/bling</td><td>Recebe webhooks do Bling ERP</td></tr>
        <tr><td><span style="background:#1e3a5f;color:#93c5fd;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">POST</span></td><td style="font-family:monospace">/api/webhooks/wms/[token]</td><td>Recebe webhooks da Smartgo WMS</td></tr>
        <tr><td><span style="background:#1e3a5f;color:#93c5fd;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">POST</span></td><td style="font-family:monospace">/api/settings/config</td><td>Configura credenciais WMS</td></tr>
        <tr><td><span style="background:#2e1065;color:#d8b4fe;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">CRON</span></td><td style="font-family:monospace">/api/crons/process-queue</td><td>Processa fila (00:00 UTC diário)</td></tr>
        <tr><td><span style="background:#2e1065;color:#d8b4fe;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">CRON</span></td><td style="font-family:monospace">/api/crons/reconcile</td><td>Reconcilia estoque (01:00 UTC)</td></tr>
        <tr><td><span style="background:#14532d;color:#86efac;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">GET</span></td><td style="font-family:monospace">/api/status</td><td>Este dashboard</td></tr>
        <tr><td><span style="background:#14532d;color:#86efac;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">GET/POST</span></td><td style="font-family:monospace">/api/admin/login</td><td>Login do dashboard</td></tr>
        <tr><td><span style="background:#1e3a5f;color:#93c5fd;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">POST</span></td><td style="font-family:monospace">/api/admin/requeue</td><td>Reprocessar evento DLQ/quarentena</td></tr>
        <tr><td><span style="background:#1e3a5f;color:#93c5fd;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">GET/POST/PATCH/DELETE</span></td><td style="font-family:monospace">/api/admin/mappings</td><td>CRUD de mapeamentos WMS↔Bling</td></tr>
        <tr><td><span style="background:#2e1065;color:#d8b4fe;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:600">CRON/POST</span></td><td style="font-family:monospace">/api/crons/refresh-token</td><td>Renova token Bling (02:00 UTC)</td></tr>
      </tbody>
    </table>
  </section>

  <section>
    <div class="sec-head"><span class="sec-title">Cron Externo (recomendado)</span></div>
    <div style="padding:16px;font-size:.8rem;color:#94a3b8;line-height:1.7">
      <p style="margin-bottom:10px">O Vercel Hobby só permite crons 1×/dia. Para processar a fila a cada 30 minutos, configure um cron gratuito em <strong style="color:#e2e8f0">cron-job.org</strong>:</p>
      <div style="background:#0f172a;border:1px solid #334155;border-radius:6px;padding:12px 16px;font-family:monospace;font-size:.75rem;color:#86efac;line-height:1.8">
        URL: https://blingxwms-marketplace-s-projects1.vercel.app/api/crons/process-queue<br>
        Método: POST<br>
        Header: Authorization: Bearer ce419bfc77f6d6ce41ee70d2d6e36f8c453abf28de9ae198<br>
        Intervalo: a cada 30 minutos
      </div>
      <p style="margin-top:10px">Configure também para o refresh-token a cada 4 horas (mesma URL base com /api/crons/refresh-token).</p>
    </div>
  </section>
</div>

<script>
let activeStatus = 'all-status', activeSrc = 'all-src';

function showTab(id) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  const tabs = document.querySelectorAll('.tab');
  const map = {overview:0, events:1, estoque:2, mappings:3, baixas:4, config:5};
  if (map[id] !== undefined) tabs[map[id]].classList.add('active');
}

function filterEv(btn, val) {
  document.querySelectorAll('.filter-btn').forEach(b => { if (b.onclick.toString().includes('filterEv')) b.classList.remove('on'); });
  btn.classList.add('on');
  activeStatus = val;
  applyFilters();
}
function filterSrc(btn, val) {
  document.querySelectorAll('.filter-btn').forEach(b => { if (b.onclick.toString().includes('filterSrc')) b.classList.remove('on'); });
  btn.classList.add('on');
  activeSrc = val;
  applyFilters();
}
function applyFilters() {
  document.querySelectorAll('#ev-table tbody .ev-row').forEach(row => {
    const s = row.dataset.status, src = row.dataset.source;
    const okStatus = activeStatus === 'all-status' || s === activeStatus;
    const okSrc = activeSrc === 'all-src' || src === activeSrc;
    row.style.display = okStatus && okSrc ? '' : 'none';
  });
}

// Auto-refresh countdown
let countdown = 30;
const btn = document.querySelector('a.refresh-btn');
setInterval(() => {
  countdown--;
  if (countdown <= 0) { window.location.reload(); return; }
  if (btn) btn.textContent = '↻ Atualizar (' + countdown + 's)';
}, 1000);

// Hash-based tab switching
const hashMap = {'#events':'events','#estoque':'estoque','#mappings':'mappings','#baixas':'baixas','#config':'config'};
if (hashMap[location.hash]) showTab(hashMap[location.hash]);

// Requeue DLQ/quarantine event
async function requeue(id) {
  if (!confirm('Reprocessar este evento? Ele voltará para a fila como pendente.')) return;
  const r = await fetch('/api/admin/requeue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ id })
  });
  if (r.ok) { location.reload(); }
  else { const d = await r.json(); alert('Erro: ' + (d.erro ?? r.status)); }
}

// Mappings CRUD
async function addMapping() {
  const wms_code = document.getElementById('new-wms').value.trim();
  const bling_sku = document.getElementById('new-sku').value.trim();
  const bling_product_id = parseInt(document.getElementById('new-pid').value);
  const msg = document.getElementById('map-msg');
  if (!wms_code || !bling_sku || !bling_product_id) {
    showMsg(msg, 'Preencha todos os campos.', '#ef4444'); return;
  }
  const r = await fetch('/api/admin/mappings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ wms_code, bling_sku, bling_product_id })
  });
  if (r.ok) { location.reload(); }
  else { const d = await r.json(); showMsg(msg, 'Erro: ' + (d.erro ?? r.status), '#ef4444'); }
}

async function toggleMapping(id, active) {
  const r = await fetch('/api/admin/mappings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ id, active: !active })
  });
  if (r.ok) location.reload();
  else alert('Erro ao atualizar mapeamento');
}

async function deleteMapping(id) {
  if (!confirm('Excluir este mapeamento permanentemente?')) return;
  const r = await fetch('/api/admin/mappings?id=' + encodeURIComponent(id), {
    method: 'DELETE',
    credentials: 'include'
  });
  if (r.ok) location.reload();
  else alert('Erro ao excluir mapeamento');
}

function showMsg(el, text, color) {
  el.style.display = 'block';
  el.style.color = color;
  el.textContent = text;
}
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(html);
}
