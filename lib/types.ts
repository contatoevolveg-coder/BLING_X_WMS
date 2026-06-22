// ── WMS Webhook ─────────────────────────────────────────────

export interface WMSProduct {
  codigoProduto: string;
  quantidade: number;
  lote: string;
}

export interface WMSMetadata {
  codigoInterno: string;
  codigoExterno: string;
  quantidadeItens: number;
  produtos: WMSProduct[];
}

export type WMSTipoEvento =
  | 'GERADO'
  | 'PEDIDO_EM_ATENDIMENTO'
  | 'FINALIZADO'
  | 'CANCELADO'
  | 'ESTORNADO';

export type WMSClassificacao = 'EXPEDICAO' | 'RECEBIMENTO';

export interface WMSWebhookPayload {
  id: string;
  docEmpresa: string;
  docDepositante: string;
  tipoEvento: WMSTipoEvento;
  dataEvento: string;
  ambiente: 'PRODUCAO' | 'SANDBOX';
  classificacao: WMSClassificacao;
  login: string;
  metadata: WMSMetadata;
}

// ── Bling Webhook ────────────────────────────────────────────

export interface BlingPedidoItem {
  id: number;
  produto: {
    id: number;
    nome: string;
    codigo: string;
  };
  quantidade: number;
}

export interface BlingPedidoData {
  id: number;
  numero?: number;
  situacao?: {
    id: number;
    nome?: string;
  };
  itens?: BlingPedidoItem[];
  [key: string]: unknown;
}

export interface BlingWebhookPayload {
  data: BlingPedidoData;
  event?: string;
  retorno?: string;
}

// ── Database Row Types ───────────────────────────────────────

export type WebhookEventStatus =
  | 'pending'
  | 'processing'
  | 'done'
  | 'failed'
  | 'dlq'
  | 'quarantine';

export type WebhookSource = 'wms' | 'bling';

export interface WebhookEvent {
  id: string;
  source: WebhookSource;
  event_type: string;
  idempotency_key: string;
  payload: unknown;
  status: WebhookEventStatus;
  retry_count: number;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface ProductMapping {
  id: string;
  wms_code: string;
  bling_sku: string;
  bling_product_id: number;
  barcode: string | null;
  display_name: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface BlingToken {
  singleton_key: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string | null;
  created_at: string;
  updated_at: string;
}

export interface StockSnapshot {
  id: string;
  source: 'wms' | 'bling';
  product_code: string;
  quantity: number;
  snapshot_at: string;
}

export interface PendingMapping {
  id: string;
  wms_code: string;
  wms_product_name: string | null;
  wms_barcode: string | null;
  bling_sku: string | null;
  bling_product_id: number | null;
  bling_product_name: string | null;
  bling_barcode: string | null;
  confidence: number;
  match_method: 'barcode' | 'exact_code' | 'fuzzy_name' | 'manual';
  status: 'pending' | 'approved' | 'rejected';
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ── Bling API Payloads ───────────────────────────────────────

export interface BlingStockMovement {
  operacao: 'E' | 'S';
  preco: number;
  custo: number;
  data: string;
  produto: { id: number };
  deposito: { id: number };
  quantidade: number;
  observacoes?: string;
}

// ── WMS API Payloads ─────────────────────────────────────────

export interface WMSExpeditionProduct {
  codigoProduto: string;
  quantidade: number;
  lote?: string;
}

export interface WMSCreateExpeditionPayload {
  codigoExterno: string;
  docDepositante: string;
  produtos: WMSExpeditionProduct[];
}

export interface WMSStockItem {
  codigoProduto: string;
  descricao: string;
  codigoBarras?: string;
  ean?: string;
  gtin?: string;
  saldoDisponivel: number;
  saldoReservado: number;
  saldoFisico: number;
}

export interface WMSCatalogProduct {
  codigoProduto: string;
  descricao: string;
  codigoBarras?: string;
  ean?: string;
  gtin?: string;
  codBarras?: string;
}

export interface ProductCatalogItem {
  id: string;
  platform: 'bling' | 'wms';
  platform_id: string;
  code: string;
  name: string;
  barcode: string | null;
  synced_at: string;
}

export interface SyncCatalogResult {
  bling_synced: number;
  wms_synced: number;
  wms_in_catalog: number;
  auto_mapped: number;
  pending_created: number;
  duration_ms: number;
}
