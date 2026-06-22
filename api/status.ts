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

  const [tokenRes, eventsRes, mappingsRes, pendingMapsRes, snapshotsRes, baixasRes, settingsRes, catalogRes] =
    await Promise.all([
      db.from('bling_tokens').select('expires_at, updated_at, scope').eq('singleton_key', 'default').single(),
      db.from('webhook_events').select('*').order('created_at', { ascending: false }).limit(200),
      db.from('product_mappings').select('*').order('created_at', { ascending: false }),
      db.from('pending_mappings').select('*').order('confidence', { ascending: false }).order('created_at', { ascending: false }),
      db.from('stock_snapshots').select('*').order('snapshot_at', { ascending: false }).limit(200),
      db.from('processed_baixas').select('*').order('created_at', { ascending: false }).limit(100),
      db.from('system_settings').select('*'),
      db.from('product_catalog').select('platform, barcode').neq('barcode', null),
    ]);

  const token     = tokenRes.data;
  const events    = eventsRes.data   ?? [];
  const mappings  = mappingsRes.data  ?? [];
  const pendingMaps = pendingMapsRes.data ?? [];
  const snapshots = snapshotsRes.data ?? [];
  const baixas    = baixasRes.data    ?? [];
  const settings  = settingsRes.data  ?? [];
  const catalogItems = catalogRes.data ?? [];
  const catalogBling = catalogItems.filter((c:Record<string,unknown>) => c['platform']==='bling').length;
  const catalogWms   = catalogItems.filter((c:Record<string,unknown>) => c['platform']==='wms').length;
  const catalogSynced = catalogBling > 0 || catalogWms > 0;

  const tokenExpiry = token ? new Date(token.expires_at) : null;
  const tokenValid  = tokenExpiry ? tokenExpiry > now : false;
  const tokenMins   = tokenExpiry ? Math.round((tokenExpiry.getTime() - now.getTime()) / 60000) : null;

  const byStatus = events.reduce<Record<string,number>>((a,e)=>{ a[e.status]=(a[e.status]??0)+1; return a; },{});
  const cntPending  = byStatus['pending']    ?? 0;
  const cntDone     = byStatus['done']       ?? 0;
  const cntFailed   = byStatus['failed']     ?? 0;
  const cntDlq      = byStatus['dlq']        ?? 0;
  const cntQuar     = byStatus['quarantine'] ?? 0;
  const cntFail     = cntFailed + cntDlq + cntQuar;
  const successRate = (cntDone + cntFail) === 0 ? 100 : Math.round(cntDone / (cntDone + cntFail) * 1000) / 10;
  const activeMaps  = mappings.filter((m:Record<string,unknown>) => m['active']).length;
  const pendingCount = pendingMaps.filter((m:Record<string,unknown>) => m['status']==='pending').length;

  const dlqEvents   = events.filter(e => e.status === 'dlq');
  const failEvents  = events.filter(e => ['failed','dlq','quarantine'].includes(e.status));
  const pendingEvs  = events.filter(e => e.status === 'pending');

  const stockByCode: Record<string,{code:string;bling?:number;wms?:number}> = {};
  for (const s of snapshots) {
    const sp = s as Record<string,unknown>;
    const code = String(sp['product_code']);
    if (!stockByCode[code]) stockByCode[code] = { code };
    if (sp['source']==='bling') stockByCode[code].bling = sp['quantity'] as number;
    else stockByCode[code].wms = sp['quantity'] as number;
  }
  const stockItems  = Object.values(stockByCode);
  const divergences = stockItems.filter(s => s.bling !== undefined && s.wms !== undefined && s.bling !== s.wms);

  const fmt = (d:string) => new Date(d).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'});
  const fmtShort = (d:string) => new Date(d).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',second:'2-digit'});

  const statusPill = (s:string) => {
    const map:Record<string,[string,string]> = {
      done:['#14532d','#86efac'], pending:['#78350f','#fde68a'], processing:['#1e3a5f','#93c5fd'],
      failed:['#7f1d1d','#fca5a5'], dlq:['#450a0a','#fca5a5'], quarantine:['#3b0764','#d8b4fe']
    };
    const [bg,fg] = map[s]??['#1e293b','#94a3b8'];
    return `<span style="background:${bg};color:${fg};padding:2px 9px;border-radius:99px;font-size:.68rem;font-weight:600;white-space:nowrap">${s}</span>`;
  };

  const srcTag = (s:string) => s==='bling'
    ? `<span style="background:#1a1e3a;color:#a78bfa;padding:2px 8px;border-radius:4px;font-size:.68rem;font-weight:600">BLING</span>`
    : `<span style="background:#1e3a5f;color:#60a5fa;padding:2px 8px;border-radius:4px;font-size:.68rem;font-weight:600">WMS</span>`;

  const reqBtn = (id:string) =>
    `<button onclick="requeue('${id}')" style="background:#1e3a5f;color:#93c5fd;border:none;border-radius:4px;padding:3px 9px;font-size:.68rem;cursor:pointer;font-weight:600">↩ Reprocessar</button>`;

  const confBadge = (n:number) => {
    const c = n>=85?'#14532d:#86efac':n>=60?'#78350f:#fde68a':'#7f1d1d:#fca5a5';
    const [bg,fg]=c.split(':');
    return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:99px;font-size:.68rem;font-weight:600">${n}%</span>`;
  };

  const evTable = (arr:typeof events, showAction=false) => {
    if (!arr.length) return `<tr><td colspan="${showAction?8:7}" style="text-align:center;color:#475569;padding:28px;font-style:italic">Nenhum evento</td></tr>`;
    return arr.map(e=>`<tr class="ev-row" data-status="${e.status}" data-src="${e.source}">
      <td>${srcTag(e.source)}</td>
      <td style="font-family:monospace;font-size:.73rem">${e.event_type}</td>
      <td>${statusPill(e.status)}</td>
      <td style="font-size:.75rem;text-align:center">${e.retry_count}</td>
      <td style="font-size:.73rem;white-space:nowrap">${fmtShort(e.created_at)}</td>
      <td style="font-size:.73rem;white-space:nowrap">${e.processed_at?fmtShort(e.processed_at):'—'}</td>
      <td style="font-size:.7rem;color:#ef4444;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(e.error??'').replace(/"/g,'&quot;')}">${e.error??'—'}</td>
      ${showAction?`<td>${['dlq','quarantine','failed'].includes(e.status)?reqBtn(e.id):'—'}</td>`:''}`
    ).join('</tr><tr>') + '</tr>';
  };

  const mapTable = mappings.length===0
    ? `<tr><td colspan="6" style="text-align:center;color:#475569;padding:28px;font-style:italic">Nenhum mapeamento. Use o formulário abaixo.</td></tr>`
    : mappings.map((m:Record<string,unknown>)=>`<tr>
        <td style="font-family:monospace">${m['wms_code']}</td>
        <td style="font-family:monospace">${m['bling_sku']}</td>
        <td style="font-family:monospace;font-size:.73rem">${m['bling_product_id']}</td>
        <td>${m['active']?`<span style="background:#14532d;color:#86efac;padding:2px 8px;border-radius:99px;font-size:.68rem;font-weight:600">Ativo</span>`:`<span style="background:#7f1d1d;color:#fca5a5;padding:2px 8px;border-radius:99px;font-size:.68rem;font-weight:600">Inativo</span>`}</td>
        <td style="font-size:.73rem">${fmt(m['created_at'] as string)}</td>
        <td>
          <button onclick="toggleMap('${m['id']}',${m['active']})" style="background:#0f172a;border:1px solid #334155;color:#94a3b8;border-radius:4px;padding:3px 8px;font-size:.68rem;cursor:pointer;margin-right:4px">${m['active']?'Desativar':'Ativar'}</button>
          <button onclick="deleteMap('${m['id']}')" style="background:#7f1d1d;color:#fca5a5;border:none;border-radius:4px;padding:3px 8px;font-size:.68rem;cursor:pointer">🗑</button>
        </td></tr>`).join('');

  const methodBadge = (mth:string) => {
    const map:Record<string,[string,string,string]> = {
      barcode:['#4c1d95','#c4b5fd','🔖 Barcode'],
      exact_code:['#1e3a5f','#93c5fd','# Código'],
      fuzzy_name:['#78350f','#fde68a','~ Nome'],
      manual:['#1e293b','#64748b','✎ Manual'],
    };
    const [bg,fg,lbl] = map[mth]??['#1e293b','#64748b',mth];
    return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:99px;font-size:.65rem;font-weight:600;white-space:nowrap">${lbl}</span>`;
  };

  const pendingMapTable = pendingMaps.length===0
    ? `<tr><td colspan="10" style="text-align:center;color:#475569;padding:28px;font-style:italic">Nenhum mapeamento pendente. Clique em "Sincronizar Catálogo" para importar produtos e gerar sugestões automáticas por código de barras.</td></tr>`
    : pendingMaps.map((m:Record<string,unknown>)=>`<tr>
        <td style="font-family:monospace">${m['wms_code']}</td>
        <td style="font-size:.73rem;color:#e2e8f0">${m['wms_product_name']??'—'}</td>
        <td style="font-family:monospace;font-size:.72rem;color:#a78bfa">${m['wms_barcode']??'—'}</td>
        <td style="font-family:monospace">${m['bling_sku']??'—'}</td>
        <td style="font-size:.73rem;color:#94a3b8">${m['bling_product_name']??'—'}</td>
        <td style="font-family:monospace;font-size:.72rem;color:#60a5fa">${m['bling_barcode']??'—'}</td>
        <td style="text-align:center">${confBadge(m['confidence'] as number)}</td>
        <td>${methodBadge(m['match_method'] as string)}</td>
        <td>${m['status']==='pending'?`<span style="background:#78350f;color:#fde68a;padding:2px 8px;border-radius:99px;font-size:.68rem;font-weight:600">Pendente</span>`:m['status']==='approved'?`<span style="background:#14532d;color:#86efac;padding:2px 8px;border-radius:99px;font-size:.68rem;font-weight:600">Aprovado</span>`:`<span style="background:#7f1d1d;color:#fca5a5;padding:2px 8px;border-radius:99px;font-size:.68rem;font-weight:600">Rejeitado</span>`}</td>
        <td style="white-space:nowrap">
          ${m['status']==='pending'?`
          <button onclick="approvePending('${m['id']}',${m['bling_product_id']??'null'},'${(m['bling_sku'] as string)??''}')" style="background:#14532d;color:#86efac;border:none;border-radius:4px;padding:3px 9px;font-size:.68rem;cursor:pointer;margin-right:4px;font-weight:600">✓ Aprovar</button>
          <button onclick="rejectPending('${m['id']}')" style="background:#7f1d1d;color:#fca5a5;border:none;border-radius:4px;padding:3px 9px;font-size:.68rem;cursor:pointer">✗ Rejeitar</button>`
          :'—'}
        </td></tr>`).join('');

  const stockTable = stockItems.length===0
    ? `<tr><td colspan="4" style="text-align:center;color:#475569;padding:28px;font-style:italic">Nenhum dado. O cron de reconciliação popula esta tabela.</td></tr>`
    : stockItems.map(s=>{
        const diff = s.bling!==undefined&&s.wms!==undefined?s.bling-s.wms:null;
        const dc = diff===null?'#64748b':diff===0?'#22c55e':'#ef4444';
        return `<tr><td style="font-family:monospace">${s.code}</td><td style="text-align:center;font-weight:600;color:${s.bling!==undefined?'#86efac':'#475569'}">${s.bling??'—'}</td><td style="text-align:center;font-weight:600;color:${s.wms!==undefined?'#60a5fa':'#475569'}">${s.wms??'—'}</td><td style="text-align:center;font-weight:700;color:${dc}">${diff!==null?(diff>0?`+${diff}`:diff):'—'}</td></tr>`;
      }).join('');

  const settingsTable = settings.length===0
    ? `<tr><td colspan="3" style="text-align:center;color:#475569;padding:28px;font-style:italic">Nenhuma configuração salva</td></tr>`
    : settings.map((s:Record<string,unknown>)=>`<tr>
        <td style="font-family:monospace">${s['key']}</td>
        <td style="font-family:monospace;font-size:.73rem;color:#94a3b8">${String(s['key']).toLowerCase().includes('key')||String(s['key']).toLowerCase().includes('token')?'••••••••••••••••':s['value']}</td>
        <td style="font-size:.73rem">${fmt(s['updated_at'] as string)}</td></tr>`).join('');

  const CARD = (label:string,val:string|number,sub:string,color='#f8fafc') =>
    `<div style="background:#1e293b;border:1px solid #334155;border-radius:10px;padding:14px 16px">
      <div style="font-size:.65rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">${label}</div>
      <div style="font-size:1.9rem;font-weight:700;color:${color};line-height:1">${val}</div>
      <div style="font-size:.7rem;color:#64748b;margin-top:5px">${sub}</div>
    </div>`;

  const SEC = (title:string,meta:string,body:string) =>
    `<div style="background:#1e293b;border:1px solid #334155;border-radius:10px;margin-bottom:16px;overflow:hidden">
      <div style="padding:12px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #334155">
        <span style="font-size:.82rem;font-weight:600;color:#94a3b8">${title}</span>
        <span style="font-size:.7rem;color:#475569">${meta}</span>
      </div>${body}</div>`;

  const TH = (...cols:string[]) =>
    `<thead><tr>${cols.map(c=>`<th style="text-align:left;font-size:.65rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.06em;padding:8px 14px;border-bottom:1px solid #334155">${c}</th>`).join('')}</tr></thead>`;

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SyncStock — Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh}
.sidebar{width:220px;flex-shrink:0;background:#1e293b;border-right:1px solid #334155;display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:10;overflow-y:auto}
.brand{padding:18px 16px;border-bottom:1px solid #334155}
.brand-name{font-size:1rem;font-weight:700;color:#f8fafc}
.brand-sub{font-size:.72rem;color:#475569;margin-top:2px}
.nav-group{font-size:.62rem;font-weight:700;color:#334155;padding:14px 16px 5px;letter-spacing:.1em;text-transform:uppercase}
.nav-item{display:flex;align-items:center;gap:9px;padding:8px 16px;font-size:.8rem;color:#64748b;cursor:pointer;border-left:2px solid transparent;transition:background .1s}
.nav-item:hover{background:#0f172a;color:#94a3b8}
.nav-item.active{background:#0f172a;color:#f8fafc;font-weight:600;border-left-color:#3b82f6}
.nav-badge{margin-left:auto;background:#7f1d1d;color:#fca5a5;font-size:.6rem;padding:1px 6px;border-radius:9px;font-weight:600}
.nav-badge-w{margin-left:auto;background:#78350f;color:#fde68a;font-size:.6rem;padding:1px 6px;border-radius:9px;font-weight:600}
.main{margin-left:220px;flex:1;padding:24px;min-height:100vh}
.topbar{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px}
.page-title{font-size:1.2rem;font-weight:700;color:#f8fafc}
.page-sub{font-size:.75rem;color:#475569;margin-top:3px}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:18px}
.dlq-alert{background:#450a0a;border:1px solid #7f1d1d;border-radius:8px;padding:10px 16px;display:flex;align-items:center;gap:10px;margin-bottom:16px;font-size:.8rem;color:#fca5a5}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}
td,th{padding:9px 14px;border-bottom:1px solid #1a2336;font-size:.78rem;color:#cbd5e1;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#1e2d44}
.filter-row{display:flex;gap:6px;padding:10px 14px;background:#172033;border-bottom:1px solid #334155;flex-wrap:wrap;align-items:center}
.filter-btn{background:#0f172a;border:1px solid #334155;color:#64748b;padding:3px 10px;border-radius:99px;font-size:.7rem;cursor:pointer;font-weight:600}
.filter-btn.on{border-color:#3b82f6;color:#93c5fd;background:#1e3a5f}
input.inp{background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:7px 12px;border-radius:6px;font-size:.78rem;outline:none;width:100%}
input.inp:focus{border-color:#3b82f6}
.view{display:none}
.view.active{display:block}
.stat-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.smc{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:10px 16px;text-align:center;min-width:80px}
.smc-n{font-size:1.4rem;font-weight:700}
.smc-l{font-size:.62rem;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
.form-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;padding:14px 16px}
label.lbl{display:block;font-size:.65rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px}
.btn-add{background:#22c55e;color:#052e16;border:none;border-radius:6px;padding:8px 18px;font-size:.78rem;font-weight:700;cursor:pointer}
.btn-add:hover{background:#16a34a}
.msg-box{padding:8px 16px;font-size:.75rem;display:none}
.status-row{display:flex;align-items:center;justify-content:space-between;padding:9px 16px;border-bottom:1px solid #1a2336;font-size:.78rem}
.status-row:last-child{border-bottom:none}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:7px}
.dot-g{background:#22c55e}.dot-a{background:#f59e0b}.dot-r{background:#ef4444}
.sidebar-footer{margin-top:auto;padding:14px 16px;border-top:1px solid #334155;font-size:.72rem;color:#475569}
</style>
</head>
<body>

<!-- ═══════════════════════════════════════ SIDEBAR ═══ -->
<nav class="sidebar">
  <div class="brand">
    <div class="brand-name">⚡ SyncStock</div>
    <div class="brand-sub">Bling ↔ WMS Smartgo</div>
  </div>

  <div class="nav-group">Operação</div>
  <div class="nav-item active" onclick="showView('dashboard',this)">📊 Dashboard</div>
  <div class="nav-item" onclick="showView('events',this)">📬 Eventos</div>
  <div class="nav-item" onclick="showView('queue',this)">⏳ Fila ${cntPending>0?`<span class="nav-badge-w">${cntPending}</span>`:''}
  </div>
  <div class="nav-item" onclick="showView('failures',this)">⚠️ Falhas ${cntFail>0?`<span class="nav-badge">${cntFail}</span>`:''}
  </div>
  <div class="nav-item" onclick="showView('dlq',this)">💀 DLQ ${cntDlq>0?`<span class="nav-badge">${cntDlq}</span>`:''}
  </div>
  <div class="nav-item" onclick="showView('stock',this)">📦 Estoque</div>

  <div class="nav-group">Cadastros</div>
  <div class="nav-item" onclick="showView('mappings',this)">🔗 Mapeamentos</div>
  <div class="nav-item" onclick="showView('auto',this)">🤖 Auto-scan ${pendingCount>0?`<span class="nav-badge-w">${pendingCount}</span>`:''}
  </div>

  <div class="nav-group">Sistema</div>
  <div class="nav-item" onclick="showView('config',this)">⚙️ Configurações</div>
  <div class="nav-item" onclick="showView('baixas',this)">✅ Baixas</div>

  <div class="sidebar-footer">
    <div><span class="dot ${tokenValid?'dot-g':'dot-r'}"></span>${tokenValid?`Token OK · ${tokenMins}min`:'Token expirado'}</div>
    <div style="margin-top:4px">${now.toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo'})}</div>
  </div>
</nav>

<!-- ═══════════════════════════════════════════ MAIN ═══ -->
<main class="main">

<!-- ══════════════════════════ VIEW: DASHBOARD ═══ -->
<div id="view-dashboard" class="view active">
  <div class="topbar">
    <div><div class="page-title">Dashboard</div><div class="page-sub">Visão geral · ${now.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo',weekday:'long',day:'numeric',month:'long'})}</div></div>
    <a href="/api/status" style="background:#1e293b;color:#93c5fd;border:1px solid #334155;padding:6px 16px;border-radius:6px;font-size:.75rem;text-decoration:none;font-weight:600">↻ Atualizar</a>
  </div>

  ${dlqEvents.length>0?`<div class="dlq-alert">💀 <strong>${dlqEvents.length} evento(s) na Dead Letter Queue</strong> — <span style="cursor:pointer;text-decoration:underline" onclick="showView('dlq',document.querySelector('.nav-item:nth-child(7)'))">Ver e reprocessar →</span></div>`:''}

  <div class="metrics">
    ${CARD('Token Bling',tokenValid?'✓ Válido':'✗ Expirado',tokenMins!==null?(tokenMins>0?`Expira em ${tokenMins} min`:`Expirou há ${Math.abs(tokenMins)} min`):'—',tokenValid?'#86efac':'#fca5a5')}
    ${CARD('Processados hoje',cntDone,`${events.length} total na fila`,'#86efac')}
    ${CARD('Falhas / DLQ',cntFail,`${cntFailed} failed · ${cntDlq} DLQ · ${cntQuar} quar.`,cntFail>0?'#fca5a5':'#86efac')}
    ${CARD('Taxa de sucesso',`${successRate}%`,`${cntDone}/${cntDone+cntFail} processados`,successRate>=99?'#86efac':successRate>=95?'#fde68a':'#fca5a5')}
    ${CARD('Mapeamentos',activeMaps,`${mappings.length} total · ${pendingCount} pendentes`,'#a78bfa')}
  </div>

  <div class="row2">
    ${SEC('Últimos Eventos',`${events.length} total`,`
      <table>${TH('Origem','Tipo','Status','Hora','Erro')}
      <tbody>${events.slice(0,6).map(e=>`<tr><td>${srcTag(e.source)}</td><td style="font-family:monospace;font-size:.73rem">${e.event_type}</td><td>${statusPill(e.status)}</td><td style="font-size:.73rem;white-space:nowrap">${fmtShort(e.created_at)}</td><td style="font-size:.7rem;color:#ef4444;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.error??'—'}</td></tr>`).join('')}</tbody>
      </table>`)}

    ${SEC('Status das Integrações','',`
      <div class="status-row"><span><span class="dot ${tokenValid?'dot-g':'dot-r'}"></span>Bling ERP (OAuth)</span><span style="font-size:.72rem;color:#475569">${tokenMins!==null?(tokenMins>0?`Expira em ${tokenMins}min`:`Expirado há ${Math.abs(tokenMins)}min`):'—'}</span><span style="background:${tokenValid?'#14532d':'#7f1d1d'};color:${tokenValid?'#86efac':'#fca5a5'};padding:2px 9px;border-radius:99px;font-size:.68rem;font-weight:600">${tokenValid?'Online':'Expirado'}</span></div>
      <div class="status-row"><span><span class="dot dot-g"></span>Supabase PostgreSQL</span><span style="font-size:.72rem;color:#475569">Conexão estável</span><span style="background:#14532d;color:#86efac;padding:2px 9px;border-radius:99px;font-size:.68rem;font-weight:600">Online</span></div>
      <div class="status-row"><span><span class="dot ${cntPending>0?'dot-a':'dot-g'}"></span>Fila de eventos</span><span style="font-size:.72rem;color:#475569">${cntPending} pendentes</span><span style="background:${cntPending>0?'#78350f':'#14532d'};color:${cntPending>0?'#fde68a':'#86efac'};padding:2px 9px;border-radius:99px;font-size:.68rem;font-weight:600">${cntPending>0?'Aguardando':'OK'}</span></div>
      <div class="status-row"><span><span class="dot ${activeMaps>0?'dot-g':'dot-a'}"></span>Mapeamentos</span><span style="font-size:.72rem;color:#475569">${activeMaps} ativos · ${pendingCount} aguardando</span><span style="background:${activeMaps>0?'#14532d':'#78350f'};color:${activeMaps>0?'#86efac':'#fde68a'};padding:2px 9px;border-radius:99px;font-size:.68rem;font-weight:600">${activeMaps>0?'Configurado':'Config. pendente'}</span></div>`)}
  </div>

  ${divergences.length>0?SEC('Divergências de Estoque (Top 5)',`${divergences.length} produto(s) divergente(s)`,`
    <table>${TH('Código','Bling','WMS','Diferença')}
    <tbody>${divergences.slice(0,5).map(s=>{const d=((s.bling??0)-(s.wms??0));return `<tr><td style="font-family:monospace">${s.code}</td><td style="text-align:center;font-weight:600;color:#86efac">${s.bling??'—'}</td><td style="text-align:center;font-weight:600;color:#60a5fa">${s.wms??'—'}</td><td style="text-align:center;font-weight:700;color:#ef4444">${d>0?`+${d}`:d}</td></tr>`;}).join('')}
    </tbody></table>`):''}

  ${pendingCount>0?SEC(`Auto-scan — ${pendingCount} mapeamentos pendentes`,`Clique em "Auto-scan" para aprovar`,`
    <table>${TH('Código WMS','Sugestão Bling','Confiança','Ação')}
    <tbody>${pendingMaps.filter(m=>(m as Record<string,unknown>)['status']==='pending').slice(0,5).map((m:Record<string,unknown>)=>`<tr>
      <td style="font-family:monospace">${m['wms_code']}</td>
      <td style="font-family:monospace">${m['bling_sku']??'—'}</td>
      <td style="text-align:center">${confBadge(m['confidence'] as number)}</td>
      <td><button onclick="approvePending('${m['id']}',${m['bling_product_id']??'null'},'${(m['bling_sku'] as string)??''}')" style="background:#14532d;color:#86efac;border:none;border-radius:4px;padding:3px 9px;font-size:.68rem;cursor:pointer;font-weight:600;margin-right:4px">✓ Aprovar</button><button onclick="rejectPending('${m['id']}')" style="background:#7f1d1d;color:#fca5a5;border:none;border-radius:4px;padding:3px 9px;font-size:.68rem;cursor:pointer">✗</button></td>
    </tr>`).join('')}</tbody></table>`):''}
</div>

<!-- ════════════════════════════ VIEW: EVENTOS ═══ -->
<div id="view-events" class="view">
  <div class="topbar"><div><div class="page-title">Fila de Eventos</div><div class="page-sub">Todos os eventos recebidos</div></div></div>
  <div class="stat-row">
    <div class="smc"><div class="smc-n">${events.length}</div><div class="smc-l">Total</div></div>
    <div class="smc"><div class="smc-n" style="color:#fde68a">${cntPending}</div><div class="smc-l">Pending</div></div>
    <div class="smc"><div class="smc-n" style="color:#86efac">${cntDone}</div><div class="smc-l">Done</div></div>
    <div class="smc"><div class="smc-n" style="color:#fca5a5">${cntFailed}</div><div class="smc-l">Failed</div></div>
    <div class="smc"><div class="smc-n" style="color:#fca5a5">${cntDlq}</div><div class="smc-l">DLQ</div></div>
    <div class="smc"><div class="smc-n" style="color:#d8b4fe">${cntQuar}</div><div class="smc-l">Quar.</div></div>
  </div>
  ${SEC('Todos os Eventos',`${events.length} (máx. 200)`,`
    <div class="filter-row">
      <span style="font-size:.72rem;color:#64748b">Status:</span>
      <button class="filter-btn on" onclick="fev(this,'all-s')">Todos</button>
      <button class="filter-btn" onclick="fev(this,'pending')">Pending</button>
      <button class="filter-btn" onclick="fev(this,'done')">Done</button>
      <button class="filter-btn" onclick="fev(this,'failed')">Failed</button>
      <button class="filter-btn" onclick="fev(this,'dlq')">DLQ</button>
      <button class="filter-btn" onclick="fev(this,'quarantine')">Quar.</button>
      &nbsp;<span style="font-size:.72rem;color:#64748b">Origem:</span>
      <button class="filter-btn on" onclick="fsrc(this,'all-src')">Todos</button>
      <button class="filter-btn" onclick="fsrc(this,'bling')">Bling</button>
      <button class="filter-btn" onclick="fsrc(this,'wms')">WMS</button>
    </div>
    <table id="ev-table">${TH('Origem','Tipo','Status','Tent.','Recebido','Processado','Erro','Ação')}
    <tbody>${evTable(events,true)}</tbody></table>`)}
</div>

<!-- ═════════════════════════════ VIEW: FILA ═══ -->
<div id="view-queue" class="view">
  <div class="topbar"><div><div class="page-title">Fila de Processamento</div><div class="page-sub">${cntPending} evento(s) aguardando</div></div></div>
  ${SEC('Eventos Pendentes',`${cntPending} itens`,`<table>${TH('Origem','Tipo','Recebido','Tentativas')}
    <tbody>${pendingEvs.length?pendingEvs.map(e=>`<tr><td>${srcTag(e.source)}</td><td style="font-family:monospace;font-size:.73rem">${e.event_type}</td><td style="font-size:.73rem">${fmt(e.created_at)}</td><td>${e.retry_count}</td></tr>`).join(''):`<tr><td colspan="4" style="text-align:center;color:#475569;padding:28px;font-style:italic">Fila vazia</td></tr>`}</tbody></table>`)}
</div>

<!-- ══════════════════════════ VIEW: FALHAS ═══ -->
<div id="view-failures" class="view">
  <div class="topbar"><div><div class="page-title">Falhas</div><div class="page-sub">${cntFail} evento(s) com falha</div></div></div>
  ${SEC('Eventos com Falha / DLQ / Quarentena',`${cntFail} itens`,`<table>${TH('Origem','Tipo','Status','Tent.','Recebido','Erro','Ação')}
    <tbody>${failEvents.length?failEvents.map(e=>`<tr><td>${srcTag(e.source)}</td><td style="font-family:monospace;font-size:.73rem">${e.event_type}</td><td>${statusPill(e.status)}</td><td style="text-align:center">${e.retry_count}</td><td style="font-size:.73rem;white-space:nowrap">${fmt(e.created_at)}</td><td style="font-size:.7rem;color:#ef4444;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(e.error??'').replace(/"/g,'&quot;')}">${e.error??'—'}</td><td>${reqBtn(e.id)}</td></tr>`).join(''):`<tr><td colspan="7" style="text-align:center;color:#475569;padding:28px;font-style:italic">Sem falhas 🎉</td></tr>`}</tbody></table>`)}
</div>

<!-- ════════════════════════════ VIEW: DLQ ═══ -->
<div id="view-dlq" class="view">
  <div class="topbar"><div><div class="page-title">Dead Letter Queue</div><div class="page-sub">${cntDlq} evento(s) na DLQ</div></div></div>
  ${cntDlq>0?`<div class="dlq-alert">⚠️ Esses eventos falharam ${3} vezes seguidas. Corrija a causa raiz antes de reprocessar.</div>`:''}
  ${SEC('Eventos DLQ',`${cntDlq} itens`,`<table>${TH('Origem','Tipo','Recebido','Erro','Ação')}
    <tbody>${dlqEvents.length?dlqEvents.map(e=>`<tr><td>${srcTag(e.source)}</td><td style="font-family:monospace;font-size:.73rem">${e.event_type}</td><td style="font-size:.73rem;white-space:nowrap">${fmt(e.created_at)}</td><td style="font-size:.7rem;color:#ef4444;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(e.error??'').replace(/"/g,'&quot;')}">${e.error??'—'}</td><td>${reqBtn(e.id)}</td></tr>`).join(''):`<tr><td colspan="5" style="text-align:center;color:#475569;padding:28px;font-style:italic">DLQ vazia 🎉</td></tr>`}</tbody></table>`)}
</div>

<!-- ══════════════════════════ VIEW: MAPEAMENTOS ═══ -->
<div id="view-mappings" class="view">
  <div class="topbar"><div><div class="page-title">Mapeamentos</div><div class="page-sub">${activeMaps} ativos de ${mappings.length} total</div></div></div>
  ${SEC('Novo Mapeamento','',`
    <div class="form-row">
      <div style="flex:1;min-width:140px"><label class="lbl">Código WMS</label><input id="nw" class="inp" placeholder="ex: PROD-001"></div>
      <div style="flex:1;min-width:140px"><label class="lbl">SKU Bling</label><input id="ns" class="inp" placeholder="ex: SKU123"></div>
      <div style="flex:1;min-width:140px"><label class="lbl">ID Produto Bling</label><input id="np" class="inp" type="number" placeholder="ex: 12345678"></div>
      <div><button class="btn-add" onclick="addMap()">+ Adicionar</button></div>
    </div>
    <div id="map-msg" class="msg-box"></div>`)}
  ${SEC('Mapeamentos Ativos',`${mappings.length} total · ${activeMaps} ativos`,`<table>${TH('Código WMS','SKU Bling','ID Bling','Status','Criado','Ações')}
    <tbody>${mapTable}</tbody></table>`)}
</div>

<!-- ══════════════════════════ VIEW: AUTO-SCAN ═══ -->
<div id="view-auto" class="view">
  <div class="topbar">
    <div><div class="page-title">Auto-scan de Produtos</div><div class="page-sub">Matching automático por código de barras EAN/GTIN + similaridade de nome</div></div>
    <button onclick="syncCatalog()" id="sync-btn" style="background:#7c3aed;color:#ede9fe;border:none;border-radius:6px;padding:8px 18px;font-size:.78rem;font-weight:700;cursor:pointer">⟳ Sincronizar Catálogo</button>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px">
    <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 16px">
      <div style="font-size:.62rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Catálogo Bling</div>
      <div style="font-size:1.5rem;font-weight:700;color:${catalogBling>0?'#a78bfa':'#475569'}">${catalogBling}</div>
      <div style="font-size:.7rem;color:#64748b;margin-top:3px">produtos com cod. barras</div>
    </div>
    <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 16px">
      <div style="font-size:.62rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Catálogo WMS</div>
      <div style="font-size:1.5rem;font-weight:700;color:${catalogWms>0?'#60a5fa':'#475569'}">${catalogWms}</div>
      <div style="font-size:.7rem;color:#64748b;margin-top:3px">produtos com cod. barras</div>
    </div>
    <div style="background:${catalogSynced?'#14532d':'#450a0a'};border:1px solid ${catalogSynced?'#166534':'#7f1d1d'};border-radius:8px;padding:12px 16px">
      <div style="font-size:.62rem;font-weight:700;color:${catalogSynced?'#4ade80':'#ef4444'};text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Status Catálogo</div>
      <div style="font-size:1rem;font-weight:700;color:${catalogSynced?'#86efac':'#fca5a5'}">${catalogSynced?'Sincronizado':'Não sincronizado'}</div>
      <div style="font-size:.7rem;color:${catalogSynced?'#4ade80':'#f87171'};margin-top:3px">${catalogSynced?'Matching por barcode ativo':'Clique em "Sincronizar Catálogo"'}</div>
    </div>
  </div>
  <div style="background:#1e3a5f;border:1px solid #2563eb;border-radius:8px;padding:12px 16px;margin-bottom:14px;font-size:.78rem;color:#93c5fd;line-height:1.7">
    <strong>Como funciona:</strong> Clique em <em>Sincronizar Catálogo</em> para puxar todos os produtos do Bling e do WMS com seus códigos de barras EAN/GTIN. O sistema vincula automaticamente produtos com o mesmo código de barras (confiança 100%) e sugere os demais por similaridade de nome. Após sincronizar, todos os eventos futuros usam o catálogo local para matching instantâneo.<br>
    <strong>Nome do produto:</strong> usa o nome do WMS quando disponível; caso contrário, usa o nome do Bling.
  </div>
  <div id="sync-result" style="display:none;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 16px;margin-bottom:14px;font-size:.78rem;color:#94a3b8"></div>
  ${SEC('Mapeamentos Pendentes de Aprovação',`${pendingCount} pendentes`,`<table>${TH('Código WMS','Nome WMS','Cod. Barras WMS','SKU Bling','Nome Bling','Cod. Barras Bling','Confiança','Método','Status','Ações')}
    <tbody>${pendingMapTable}</tbody></table>`)}
  <div id="auto-msg" style="margin-top:10px;font-size:.78rem;display:none"></div>
</div>

<!-- ══════════════════════════ VIEW: ESTOQUE ═══ -->
<div id="view-stock" class="view">
  <div class="topbar"><div><div class="page-title">Comparativo de Estoque</div><div class="page-sub">Bling × WMS Smartgo</div></div></div>
  ${divergences.length>0?`<div class="dlq-alert" style="background:#450a0a;border-color:#7f1d1d;color:#fca5a5">⚠️ ${divergences.length} produto(s) com divergência de estoque detectada</div>`:''}
  ${SEC('Estoque Bling × WMS',`${stockItems.length} produto(s)`,`<table>${TH('Código','Qtd Bling','Qtd WMS','Diferença')}
    <tbody>${stockTable}</tbody></table>`)}
</div>

<!-- ══════════════════════════ VIEW: BAIXAS ═══ -->
<div id="view-baixas" class="view">
  <div class="topbar"><div><div class="page-title">Baixas Processadas</div><div class="page-sub">Registro de idempotência</div></div></div>
  ${SEC('Histórico de Baixas',`${baixas.length} registros`,`<table>${TH('Código WMS','ID do Evento','Processado em')}
    <tbody>${baixas.length?baixas.map((b:Record<string,unknown>)=>`<tr><td style="font-family:monospace">${b['wms_code']}</td><td style="font-family:monospace;font-size:.73rem">${b['event_id']}</td><td style="font-size:.73rem">${fmt(b['created_at'] as string)}</td></tr>`).join(''):`<tr><td colspan="3" style="text-align:center;color:#475569;padding:28px;font-style:italic">Nenhuma baixa ainda</td></tr>`}</tbody></table>`)}
</div>

<!-- ══════════════════════════ VIEW: CONFIG ═══ -->
<div id="view-config" class="view">
  <div class="topbar"><div><div class="page-title">Configurações</div><div class="page-sub">Variáveis e endpoints do sistema</div></div></div>
  ${SEC('Configurações Salvas',`${settings.length} chave(s)`,`<table>${TH('Chave','Valor','Atualizado')}
    <tbody>${settingsTable}</tbody></table>`)}
  ${SEC('Endpoints da API','',`<table>${TH('Método','Rota','Descrição')}
    <tbody>
      <tr><td><span style="background:#14532d;color:#86efac;padding:2px 9px;border-radius:4px;font-size:.68rem;font-weight:600">GET</span></td><td style="font-family:monospace">/api/auth/start</td><td>Inicia OAuth com Bling</td></tr>
      <tr><td><span style="background:#1e3a5f;color:#93c5fd;padding:2px 9px;border-radius:4px;font-size:.68rem;font-weight:600">POST</span></td><td style="font-family:monospace">/api/webhooks/bling</td><td>Webhook Bling ERP</td></tr>
      <tr><td><span style="background:#1e3a5f;color:#93c5fd;padding:2px 9px;border-radius:4px;font-size:.68rem;font-weight:600">POST</span></td><td style="font-family:monospace">/api/webhooks/wms/[token]</td><td>Webhook WMS Smartgo</td></tr>
      <tr><td><span style="background:#1e3a5f;color:#93c5fd;padding:2px 9px;border-radius:4px;font-size:.68rem;font-weight:600">POST</span></td><td style="font-family:monospace">/api/admin/mappings</td><td>Reprocessar evento DLQ (action:requeue)</td></tr>
      <tr><td><span style="background:#1e3a5f;color:#93c5fd;padding:2px 9px;border-radius:4px;font-size:.68rem;font-weight:600">CRUD</span></td><td style="font-family:monospace">/api/admin/mappings</td><td>CRUD de mapeamentos</td></tr>
      <tr><td><span style="background:#1e3a5f;color:#93c5fd;padding:2px 9px;border-radius:4px;font-size:.68rem;font-weight:600">CRUD</span></td><td style="font-family:monospace">/api/admin/pending-mappings</td><td>Aprovação de auto-scan</td></tr>
      <tr><td><span style="background:#3b0764;color:#d8b4fe;padding:2px 9px;border-radius:4px;font-size:.68rem;font-weight:600">CRON</span></td><td style="font-family:monospace">/api/crons/process-queue</td><td>Processa fila (00:00 UTC)</td></tr>
      <tr><td><span style="background:#3b0764;color:#d8b4fe;padding:2px 9px;border-radius:4px;font-size:.68rem;font-weight:600">CRON</span></td><td style="font-family:monospace">/api/crons/reconcile</td><td>Reconcilia estoque (01:00 UTC)</td></tr>
      <tr><td><span style="background:#3b0764;color:#d8b4fe;padding:2px 9px;border-radius:4px;font-size:.68rem;font-weight:600">CRON</span></td><td style="font-family:monospace">/api/crons/refresh-token</td><td>Renova token Bling (02:00 UTC)</td></tr>
    </tbody></table>`)}
  <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;margin-top:14px;overflow:hidden">
    <div style="padding:12px 16px;border-bottom:1px solid #334155"><span style="font-size:.82rem;font-weight:600;color:#94a3b8">Cron Externo — processar fila a cada 30min (cron-job.org)</span></div>
    <div style="padding:14px 16px;font-size:.78rem;color:#94a3b8;line-height:1.7">
      <div style="background:#0f172a;border:1px solid #334155;border-radius:6px;padding:12px 16px;font-family:monospace;font-size:.73rem;color:#86efac;line-height:1.9">
        URL: https://blingxwms-marketplace-s-projects1.vercel.app/api/crons/process-queue<br>
        Método: POST<br>
        Header: Authorization: Bearer ce419bfc77f6d6ce41ee70d2d6e36f8c453abf28de9ae198<br>
        Intervalo: a cada 30 minutos
      </div>
    </div>
  </div>
</div>

</main>

<script>
let activeEvStatus='all-s', activeEvSrc='all-src';

function showView(id, el) {
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('view-'+id).classList.add('active');
  if (el) el.classList.add('active');
  location.hash = id;
}

function fev(btn, val) {
  document.querySelectorAll('.filter-btn').forEach(b=>{ if(b.onclick&&b.onclick.toString().includes('fev')) b.classList.remove('on'); });
  btn.classList.add('on'); activeEvStatus=val; applyEvFilters();
}
function fsrc(btn, val) {
  document.querySelectorAll('.filter-btn').forEach(b=>{ if(b.onclick&&b.onclick.toString().includes('fsrc')) b.classList.remove('on'); });
  btn.classList.add('on'); activeEvSrc=val; applyEvFilters();
}
function applyEvFilters() {
  document.querySelectorAll('#ev-table tbody tr.ev-row').forEach(row=>{
    const s=row.dataset.status, src=row.dataset.src;
    const okS = activeEvStatus==='all-s'||s===activeEvStatus;
    const okSrc = activeEvSrc==='all-src'||src===activeEvSrc;
    row.style.display = okS&&okSrc?'':'none';
  });
}

async function requeue(id) {
  if (!confirm('Reprocessar este evento? Voltará para a fila como pendente.')) return;
  const r = await fetch('/api/admin/mappings',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({action:'requeue',id})});
  if (r.ok) location.reload(); else { const d=await r.json(); alert('Erro: '+(d.erro??r.status)); }
}

async function addMap() {
  const wms_code=document.getElementById('nw').value.trim();
  const bling_sku=document.getElementById('ns').value.trim();
  const bling_product_id=parseInt(document.getElementById('np').value);
  const msg=document.getElementById('map-msg');
  if (!wms_code||!bling_sku||!bling_product_id) { showMsg(msg,'Preencha todos os campos.','#ef4444'); return; }
  const r=await fetch('/api/admin/mappings',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({wms_code,bling_sku,bling_product_id})});
  if (r.ok) location.reload(); else { const d=await r.json(); showMsg(msg,'Erro: '+(d.erro??r.status),'#ef4444'); }
}
async function toggleMap(id,active) {
  const r=await fetch('/api/admin/mappings',{method:'PATCH',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({id,active:!active})});
  if (r.ok) location.reload(); else alert('Erro ao atualizar');
}
async function deleteMap(id) {
  if (!confirm('Excluir este mapeamento permanentemente?')) return;
  const r=await fetch('/api/admin/mappings?id='+encodeURIComponent(id),{method:'DELETE',credentials:'include'});
  if (r.ok) location.reload(); else alert('Erro ao excluir');
}

async function approvePending(id, blingProductId, blingSku) {
  let pid = blingProductId, sku = blingSku;
  if (!pid || !sku) {
    pid = parseInt(prompt('ID do produto no Bling:')||'');
    sku = prompt('SKU do produto no Bling:')||'';
    if (!pid||!sku) return;
  }
  const r=await fetch('/api/admin/pending-mappings',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({id,action:'approve',bling_product_id:pid,bling_sku:sku})});
  const msg=document.getElementById('auto-msg');
  if (r.ok) { location.reload(); } else { const d=await r.json(); showMsg(msg,'Erro: '+(d.erro??r.status),'#ef4444'); }
}
async function rejectPending(id) {
  if (!confirm('Rejeitar esta sugestão?')) return;
  const r=await fetch('/api/admin/pending-mappings',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({id,action:'reject'})});
  if (r.ok) location.reload(); else alert('Erro ao rejeitar');
}

async function syncCatalog() {
  const btn=document.getElementById('sync-btn');
  const res=document.getElementById('sync-result');
  if(btn){btn.disabled=true;btn.textContent='⟳ Sincronizando...';}
  if(res){res.style.display='none';}
  try {
    const r=await fetch('/api/admin/mappings',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({action:'sync-catalog'})});
    const d=await r.json();
    if(r.ok&&d.sucesso){
      if(res){
        res.style.display='block';
        res.innerHTML='<span style="color:#86efac;font-weight:700">&#10003; Sincronização concluída!</span><br>'
          +' Bling: <strong>'+d.bling_synced+'</strong> produtos &nbsp;&middot;&nbsp;'
          +' WMS: <strong>'+d.wms_synced+'</strong> produtos &nbsp;&middot;&nbsp;'
          +' Auto-mapeados por barcode: <strong style="color:#c4b5fd">'+d.auto_mapped+'</strong> &nbsp;&middot;&nbsp;'
          +' Sugestões criadas: <strong style="color:#fde68a">'+d.pending_created+'</strong> &nbsp;&middot;&nbsp;'
          +' Duração: '+Math.round(d.duration_ms/1000)+'s';
      }
      setTimeout(()=>location.reload(),2500);
    } else {
      if(res){res.style.display='block';res.style.color='#ef4444';res.textContent='Erro: '+(d.erro??'Falha desconhecida');}
    }
  } catch(e) {
    if(res){res.style.display='block';res.style.color='#ef4444';res.textContent='Erro de rede: '+e;}
  } finally {
    if(btn){btn.disabled=false;btn.textContent='⟳ Sincronizar Catálogo';}
  }
}

function showMsg(el,text,color) { el.style.display='block'; el.style.color=color; el.textContent=text; }

const hashViews = {dashboard:0,events:1,queue:2,failures:3,dlq:4,stock:5,mappings:6,auto:7,config:8,baixas:9};
const navItems = document.querySelectorAll('.nav-item');
const h = location.hash.replace('#','');
if (hashViews[h]!==undefined) {
  showView(h, navItems[hashViews[h]]);
}

// Auto-refresh a cada 60s
let cd=60;
setInterval(()=>{ cd--; if(cd<=0) location.reload(); },1000);
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(html);
}
