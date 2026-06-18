import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../lib/supabase';

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const db = getSupabase();
  const now = new Date();

  const [tokenRes, eventsRes, mappingsRes] = await Promise.all([
    db.from('bling_tokens').select('expires_at, updated_at, scope').eq('singleton_key', 'default').single(),
    db.from('webhook_events').select('id, source, event_type, status, error, created_at, processed_at').order('created_at', { ascending: false }).limit(20),
    db.from('product_mappings').select('id, wms_code, bling_sku, active').order('created_at', { ascending: false }).limit(50),
  ]);

  const token = tokenRes.data;
  const events = eventsRes.data ?? [];
  const mappings = mappingsRes.data ?? [];

  const tokenExpiry = token ? new Date(token.expires_at) : null;
  const tokenValid = tokenExpiry ? tokenExpiry > now : false;
  const tokenExpiresIn = tokenExpiry
    ? Math.round((tokenExpiry.getTime() - now.getTime()) / 60000)
    : null;

  const statusCounts = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});

  const statusColor = (s: string) => {
    const map: Record<string, string> = {
      done: '#22c55e', pending: '#f59e0b', processing: '#3b82f6',
      failed: '#ef4444', dlq: '#dc2626', quarantine: '#a855f7',
    };
    return map[s] ?? '#6b7280';
  };

  const fmtDate = (d: string) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SyncStock — Painel de Status</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 24px; }
  h1 { font-size: 1.5rem; font-weight: 700; color: #f8fafc; margin-bottom: 4px; }
  .subtitle { font-size: 0.85rem; color: #64748b; margin-bottom: 28px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 28px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; }
  .card-title { font-size: 0.7rem; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px; }
  .card-value { font-size: 1.8rem; font-weight: 700; color: #f8fafc; }
  .card-sub { font-size: 0.75rem; color: #94a3b8; margin-top: 4px; }
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; border-radius: 99px; font-size: 0.72rem; font-weight: 600; }
  .ok { background: #14532d; color: #86efac; }
  .warn { background: #78350f; color: #fde68a; }
  .err { background: #7f1d1d; color: #fca5a5; }
  section { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
  section h2 { font-size: 0.9rem; font-weight: 600; color: #94a3b8; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  th { text-align: left; color: #64748b; font-weight: 600; padding: 6px 10px; border-bottom: 1px solid #334155; font-size: 0.72rem; text-transform: uppercase; letter-spacing: .06em; }
  td { padding: 8px 10px; border-bottom: 1px solid #1e293b; color: #cbd5e1; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #243144; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
  .tag { display: inline-block; padding: 1px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; }
  .empty { color: #475569; font-style: italic; text-align: center; padding: 24px 0; }
  .flow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .step { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; font-size: 0.78rem; color: #94a3b8; }
  .step strong { color: #e2e8f0; display: block; margin-bottom: 2px; }
  .arrow { color: #334155; font-size: 1.2rem; }
  .refresh { font-size: 0.72rem; color: #475569; }
</style>
</head>
<body>
<h1>⚡ SyncStock — Painel de Status</h1>
<p class="subtitle">Atualizado em ${now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} &nbsp;·&nbsp; <a href="/api/status" style="color:#3b82f6;text-decoration:none">↻ Atualizar</a></p>

<div class="grid">
  <div class="card">
    <div class="card-title">Token Bling</div>
    <div style="margin-bottom:8px">
      ${tokenValid
        ? `<span class="badge ok">✓ Válido</span>`
        : `<span class="badge err">✗ Expirado</span>`
      }
    </div>
    <div class="card-sub">${tokenExpiresIn !== null
      ? (tokenExpiresIn > 0 ? `Expira em ${tokenExpiresIn} min` : `Expirou há ${Math.abs(tokenExpiresIn)} min`)
      : 'Token não encontrado'}</div>
    ${token ? `<div class="card-sub" style="margin-top:4px">Atualizado: ${fmtDate(token.updated_at)}</div>` : ''}
  </div>
  <div class="card">
    <div class="card-title">Eventos na Fila</div>
    <div class="card-value">${events.length}</div>
    <div class="card-sub">${Object.entries(statusCounts).map(([s, n]) =>
      `<span class="dot" style="background:${statusColor(s)}"></span>${n} ${s}`
    ).join(' &nbsp; ')}</div>
  </div>
  <div class="card">
    <div class="card-title">Mapeamentos de Produto</div>
    <div class="card-value">${mappings.filter(m => m.active).length}</div>
    <div class="card-sub">${mappings.length} total · ${mappings.filter(m => !m.active).length} inativos</div>
  </div>
  <div class="card">
    <div class="card-title">Deploy</div>
    <div style="margin-bottom:8px"><span class="badge ok">✓ Online</span></div>
    <div class="card-sub">Vercel · Production</div>
    <div class="card-sub" style="margin-top:4px">Hobby Plan · Serverless</div>
  </div>
</div>

<section>
  <h2>Fluxo de Automação <span class="refresh">Como funciona</span></h2>
  <div class="flow">
    <div class="step"><strong>1. WMS Smartgo</strong>Expedição finalizada → POST webhook</div>
    <div class="arrow">→</div>
    <div class="step"><strong>2. Fila Supabase</strong>Evento salvo como <em>pending</em></div>
    <div class="arrow">→</div>
    <div class="step"><strong>3. Worker (Cron)</strong>Processa lotes de 10 eventos</div>
    <div class="arrow">→</div>
    <div class="step"><strong>4. Bling ERP</strong>Baixa de estoque registrada via API</div>
  </div>
  <div class="flow">
    <div class="step"><strong>Alt: Bling Webhook</strong>Pedido atualizado → POST webhook</div>
    <div class="arrow">→</div>
    <div class="step"><strong>Fila Supabase</strong>Evento salvo como <em>pending</em></div>
    <div class="arrow">→</div>
    <div class="step"><strong>Worker (Cron)</strong>Cria expedição no WMS</div>
    <div class="arrow">→</div>
    <div class="step"><strong>Smartgo WMS</strong>Ordem de separação criada</div>
  </div>
</section>

<section>
  <h2>Últimos Eventos da Fila <span style="font-size:0.72rem;color:#475569">${events.length} evento(s)</span></h2>
  ${events.length === 0
    ? `<p class="empty">Nenhum evento registrado ainda.</p>`
    : `<table>
        <thead><tr><th>Origem</th><th>Tipo</th><th>Status</th><th>Recebido</th><th>Processado</th><th>Erro</th></tr></thead>
        <tbody>
        ${events.map(e => `
          <tr>
            <td><span class="tag" style="background:${e.source === 'wms' ? '#1e3a5f' : '#1a1e3a'};color:${e.source === 'wms' ? '#60a5fa' : '#a78bfa'}">${e.source.toUpperCase()}</span></td>
            <td style="color:#e2e8f0;font-family:monospace;font-size:0.75rem">${e.event_type}</td>
            <td><span class="dot" style="background:${statusColor(e.status)}"></span>${e.status}</td>
            <td style="white-space:nowrap">${fmtDate(e.created_at)}</td>
            <td style="white-space:nowrap">${e.processed_at ? fmtDate(e.processed_at) : '—'}</td>
            <td style="color:#ef4444;font-size:0.72rem;max-width:200px;overflow:hidden;text-overflow:ellipsis">${e.error ?? '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
</section>

<section>
  <h2>Mapeamentos WMS ↔ Bling <span style="font-size:0.72rem;color:#475569">${mappings.length} cadastrado(s)</span></h2>
  ${mappings.length === 0
    ? `<p class="empty">Nenhum mapeamento cadastrado. Use <code style="background:#0f172a;padding:2px 6px;border-radius:4px">/api/mappings</code> para cadastrar produtos.</p>`
    : `<table>
        <thead><tr><th>Código WMS</th><th>SKU Bling</th><th>Status</th></tr></thead>
        <tbody>
        ${mappings.map(m => `
          <tr>
            <td style="font-family:monospace">${m.wms_code}</td>
            <td style="font-family:monospace">${m.bling_sku}</td>
            <td><span class="badge ${m.active ? 'ok' : 'err'}">${m.active ? 'Ativo' : 'Inativo'}</span></td>
          </tr>`).join('')}
        </tbody>
      </table>`}
</section>

<section>
  <h2>Endpoints da API</h2>
  <table>
    <thead><tr><th>Método</th><th>Rota</th><th>Descrição</th></tr></thead>
    <tbody>
      <tr><td><span class="tag" style="background:#14532d;color:#86efac">GET</span></td><td style="font-family:monospace">/api/auth/start</td><td>Inicia OAuth com o Bling</td></tr>
      <tr><td><span class="tag" style="background:#14532d;color:#86efac">GET</span></td><td style="font-family:monospace">/api/auth/callback</td><td>Callback OAuth — salva tokens</td></tr>
      <tr><td><span class="tag" style="background:#1e3a5f;color:#93c5fd">POST</span></td><td style="font-family:monospace">/api/webhooks/bling</td><td>Recebe webhooks do Bling ERP</td></tr>
      <tr><td><span class="tag" style="background:#1e3a5f;color:#93c5fd">POST</span></td><td style="font-family:monospace">/api/webhooks/wms/[token]</td><td>Recebe webhooks da Smartgo WMS</td></tr>
      <tr><td><span class="tag" style="background:#1e3a5f;color:#93c5fd">POST</span></td><td style="font-family:monospace">/api/settings/config</td><td>Configura credenciais WMS</td></tr>
      <tr><td><span class="tag" style="background:#2e1065;color:#c4b5fd">CRON</span></td><td style="font-family:monospace">/api/crons/process-queue</td><td>Processa fila de eventos (00:00 UTC)</td></tr>
      <tr><td><span class="tag" style="background:#2e1065;color:#c4b5fd">CRON</span></td><td style="font-family:monospace">/api/crons/reconcile</td><td>Reconcilia estoque (01:00 UTC)</td></tr>
    </tbody>
  </table>
</section>

</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(html);
}
