import { getSupabase } from '../supabase';
import { logger } from '../logger';
import { deductStock } from '../adapters/bling';
import { getSetting } from '../settings';
import { markQuarantine } from './queue';
import { tryAutoMap } from './auto-map';
import type {
  WebhookEvent,
  WMSWebhookPayload,
} from '../types';

async function getBlingDepositoId(): Promise<number> {
  const raw = await getSetting('BLING_DEPOSITO_ID').catch(
    () => process.env['BLING_DEPOSITO_ID'] ?? ''
  );
  const id = parseInt(raw, 10);
  if (!id) throw new Error('Missing or invalid BLING_DEPOSITO_ID (configure em system_settings ou env var)');
  return id;
}

/**
 * Retorna a data atual no formato YYYY-MM-DD para uso nas baixas do Bling.
 * @returns {string} Data em formato ISO (somente a parte da data).
 */
function todayISO(): string {
  return new Date().toISOString().split('T')[0] ?? '';
}

// ── Flow A: WMS → Bling baixa ────────────────────────────────

/**
 * PROCESSAMENTO DE MOVIMENTAÇÃO DE ESTOQUE (WMS -> Bling)
 * Comunicação: Recebe um evento do WMS (Expedição Finalizada, Cancelada ou Estornada)
 * e envia a movimentação para o Bling (Saída ou Entrada).
 * 
 * 1. Extrai a lista de produtos recebidos do WMS.
 * 2. Consulta a tabela `product_mappings` no banco de dados (Supabase) para encontrar o ID correspondente no Bling.
 * 3. Se algum produto não estiver mapeado, o evento inteiro é colocado em quarentena.
 * 4. Dispara as chamadas para a API do Bling (`deductStock`) paralelamente em lotes (chunks) para evitar limite de requisições.
 * 
 * @param event O evento de webhook recuperado do banco de dados.
 */
export async function processStockMovement(event: WebhookEvent): Promise<void> {
  const payload = event.payload as WMSWebhookPayload;
  const produtos = payload.metadata.produtos;
  const codigoInterno = payload.metadata.codigoInterno;
  const db = getSupabase();
  const depositoId = await getBlingDepositoId();
  const wmsCodes = produtos.map((p) => p.codigoProduto);

  // Evita erro na query do Supabase caso o array venha vazio
  if (wmsCodes.length === 0) {
    logger.warn('stock-service', 'Expedição sem produtos', { codigoInterno });
    return;
  }

  const isEstorno = payload.tipoEvento === 'CANCELADO' || payload.tipoEvento === 'ESTORNADO';
  const operacaoBling = isEstorno ? 'E' : 'S'; // E = Entrada (Devolução/Estorno), S = Saída (Baixa)
  const operacaoNome = isEstorno ? 'Estorno/Devolução' : 'Baixa';

  // Consulta todos os mapeamentos de uma só vez (Performance: previne N+1 queries)
  const { data: mappings, error: mappingError } = await db
    .from('product_mappings')
    .select('wms_code, bling_product_id')
    .in('wms_code', wmsCodes)
    .eq('active', true);

  if (mappingError) {
    throw new Error(`Falha ao buscar mapeamentos: ${mappingError.message}`);
  }

  // Busca na tabela processed_baixas para idempotência — inclui status para
  // distinguir baixa confirmada ('done') de lock em andamento ('processing').
  const { data: existingBaixas } = await db
    .from('processed_baixas')
    .select('wms_code, status, created_at')
    .eq('event_id', event.id)
    .in('wms_code', wmsCodes);

  const baixasByCode = new Map(
    (existingBaixas || []).map((row) => [row.wms_code, row])
  );

  const STALE_LOCK_MS = 5 * 60 * 1000; // 5 minutos — lock órfão de um crash anterior

  const processedSet = new Set<string>();
  for (const [code, row] of baixasByCode) {
    if (row.status === 'done') {
      processedSet.add(code);
      continue;
    }
    // status === 'processing'
    const age = Date.now() - new Date(row.created_at).getTime();
    if (age < STALE_LOCK_MS) {
      // Lock recente — presumivelmente outra tentativa em andamento; não reprocessa agora.
      processedSet.add(code);
      logger.info('stock-service', `Item ${code} com lock 'processing' recente — pulando nesta execução`, { event_id: event.id });
    } else {
      // Lock órfão (crash anterior entre a chamada ao Bling e a confirmação) — libera para retry.
      logger.warn('stock-service', `Lock 'processing' órfão para ${code} — removendo e permitindo retry`, { event_id: event.id, age_ms: age });
      await db.from('processed_baixas').delete().eq('wms_code', code).eq('event_id', event.id);
    }
  }

  // Cria um dicionário em memória para acesso rápido O(1)
  const mappingsByWmsCode = new Map(
    mappings?.map((m) => [m.wms_code, m.bling_product_id as number])
  );

  const resolvedProducts: Array<{
    wms_code: string;
    bling_product_id: number;
    quantidade: number;
  }> = [];

  // Agrega as quantidades caso o WMS mande o mesmo SKU em múltiplas linhas (ex: múltiplos lotes)
  const aggregatedProdutos = new Map<string, number>();
  for (const produto of produtos) {
    aggregatedProdutos.set(
      produto.codigoProduto,
      (aggregatedProdutos.get(produto.codigoProduto) || 0) + produto.quantidade
    );
  }

  // Valida e prepara o payload para o Bling
  for (const [wmsCode, qtde] of aggregatedProdutos) {
    if (processedSet.has(wmsCode)) {
      logger.info('stock', `Item ${wmsCode} ignorado na expedição ${event.id} (já processado)`);
      continue;
    }

    let blingProductId = mappingsByWmsCode.get(wmsCode);

    if (!blingProductId) {
      // Tenta auto-mapear antes de quarentenar
      const autoResult = await tryAutoMap(wmsCode);
      if (autoResult) {
        blingProductId = autoResult.blingProductId;
        logger.info('stock-service', `Auto-mapeamento aplicado para "${wmsCode}"`);
      } else {
        await markQuarantine(
          event.id,
          `Código WMS "${wmsCode}" sem mapeamento (expedição ${codigoInterno}). ` +
            `Sugestão salva em "Auto-scan" — reprocesse após aprovar.`
        );
        return;
      }
    }

    resolvedProducts.push({
      wms_code: wmsCode,
      bling_product_id: blingProductId,
      quantidade: qtde,
    });
  }

  if (resolvedProducts.length === 0) {
    logger.info('stock-service', `Expedição ${event.id} completamente processada (idempotência).`);
    return;
  }

  // Despacha as requisições para a API do Bling em blocos (chunks)
  // Isso acelera a baixa de múltiplos itens sem sobrecarregar a API remota (Rate Limit)
  const chunkSize = 5;
  for (let i = 0; i < resolvedProducts.length; i += chunkSize) {
    const chunk = resolvedProducts.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async (resolved) => {
        // Adquire o lock ANTES de chamar o Bling (status='processing', default da coluna).
        // Se outra tentativa concorrente já criou o lock, o INSERT falha com 23505 (unique
        // violation) e pulamos o item — evita debitar duas vezes na mesma janela.
        const { error: lockError } = await db.from('processed_baixas').insert({
          wms_code: resolved.wms_code,
          event_id: event.id,
        });

        if (lockError) {
          if (lockError.code === '23505') {
            logger.info('stock-service', `Lock já existente para ${resolved.wms_code} (concorrência) — pulando`, { event_id: event.id });
            return;
          }
          throw new Error(`Falha ao gravar lock de idempotência: ${lockError.message}`);
        }

        try {
          // Faz a requisição na API do Bling
          await deductStock({
            operacao: operacaoBling,
            preco: 0,
            custo: 0,
            data: todayISO(),
            produto: { id: resolved.bling_product_id },
            deposito: { id: depositoId },
            quantidade: resolved.quantidade,
            observacoes: `${operacaoNome} WMS Expedição ${codigoInterno}`,
          });

          // Confirma a baixa — transição final do lock e preenchimento de colunas de auditoria.
          const { error: confirmError } = await db
            .from('processed_baixas')
            .update({ 
              status: 'done',
              quantity: resolved.quantidade,
              bling_product_id: resolved.bling_product_id,
              bling_deposito_id: depositoId
            })
            .eq('wms_code', resolved.wms_code)
            .eq('event_id', event.id);

          if (confirmError) {
            throw new Error(`Falha ao confirmar baixa: ${confirmError.message}`);
          }
        } catch (err) {
          // Falha na chamada ao Bling (ou na confirmação) — remove o lock para permitir
          // que o próximo retry tente de novo, em vez de ficar preso em 'processing'.
          await db.from('processed_baixas').delete().eq('wms_code', resolved.wms_code).eq('event_id', event.id);
          throw err;
        }
      })
    );
  }

  logger.info('stock-service', `Movimentação de estoque concluída no Bling (${operacaoNome})`, {
    event_id: event.id,
    codigoInterno,
    product_count: resolvedProducts.length,
  });
}

