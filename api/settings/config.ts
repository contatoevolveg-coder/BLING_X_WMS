import { VercelRequest, VercelResponse } from '@vercel/node';
import { setSetting } from '../../lib/settings';
import { pingWmsConnection } from '../../lib/adapters/wms';
import { isDashAuthenticated } from '../../lib/auth';
import { logger } from '../../lib/logger';
import { z } from 'zod';

const configSchema = z.object({
  wms_api_key: z.string().min(1, 'wms_api_key é obrigatório'),
  wms_base_url: z.string().url('wms_base_url deve ser uma URL válida'),
  wms_doc_depositante: z.string().min(1, 'wms_doc_depositante é obrigatório'),
});

/**
 * Endpoint para cadastrar e validar credenciais do WMS manualmente.
 * 
 * POST /api/settings/config
 * Body: { wms_api_key: '...', wms_base_url: '...', wms_doc_depositante: '...' }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isDashAuthenticated(req)) {
    res.status(401).json({ erro: 'Não autorizado' });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ erro: 'Método não permitido' });
    return;
  }

  try {
    const parsed = configSchema.safeParse(req.body);
    
    if (!parsed.success) {
      res.status(400).json({ 
        sucesso: false, 
        erro: 'Parâmetros inválidos', 
        detalhes: parsed.error.issues 
      });
      return;
    }

    const { wms_api_key, wms_base_url, wms_doc_depositante } = parsed.data;

    // 1. Validar conexão fazendo um ping
    const isValid = await pingWmsConnection(wms_api_key, wms_base_url, wms_doc_depositante);

    if (!isValid) {
      res.status(400).json({ 
        sucesso: false, 
        erro: 'Falha ao conectar no WMS com essas credenciais. Verifique a URL, Token e Depositante.' 
      });
      return;
    }

    // 2. Salvar configurações validadas no banco
    await setSetting('WMS_API_KEY', wms_api_key);
    await setSetting('WMS_BASE_URL', wms_base_url);
    await setSetting('WMS_DOC_DEPOSITANTE', wms_doc_depositante);

    logger.info('settings', 'Configurações do WMS atualizadas via API');

    res.status(200).json({
      sucesso: true,
      mensagem: 'Credenciais válidas e configurações salvas com sucesso no banco de dados.'
    });

  } catch (error) {
    logger.error('settings', 'Erro ao salvar configurações', { erro: String(error) });
    res.status(500).json({ sucesso: false, erro: 'Erro interno no servidor' });
  }
}
