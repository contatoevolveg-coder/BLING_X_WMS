import { VercelRequest, VercelResponse } from '@vercel/node';
import { setSetting } from '../../lib/settings';
import { pingWmsConnection } from '../../lib/adapters/wms';
import { isDashAuthenticated } from '../../lib/auth';
import { logger } from '../../lib/logger';
import { z } from 'zod';

const configSchema = z.object({
  wms_api_key:         z.string().min(1, 'wms_api_key é obrigatório'),
  wms_base_url:        z.string().url('wms_base_url deve ser uma URL válida'),
  wms_doc_depositante: z.string().min(1, 'wms_doc_depositante é obrigatório'),
});

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
        detalhes: parsed.error.issues,
      });
      return;
    }

    const { wms_api_key, wms_base_url, wms_doc_depositante } = parsed.data;

    // Salva imediatamente — sem bloquear no ping
    await setSetting('WMS_API_KEY',         wms_api_key);
    await setSetting('WMS_BASE_URL',         wms_base_url);
    await setSetting('WMS_DOC_DEPOSITANTE',  wms_doc_depositante);

    logger.info('settings', 'Credenciais WMS salvas', { url: wms_base_url });

    // Tenta ping em background para informar o usuário, mas não bloqueia o save
    let pingOk = false;
    let pingErro: string | null = null;
    try {
      pingOk = await pingWmsConnection(wms_api_key, wms_base_url, wms_doc_depositante);
      if (!pingOk) pingErro = 'WMS retornou status de erro na validação';
    } catch (e) {
      pingErro = String(e);
    }

    res.status(200).json({
      sucesso: true,
      ping_ok: pingOk,
      mensagem: pingOk
        ? 'Credenciais salvas e conexão com WMS confirmada!'
        : `Credenciais salvas, mas o teste de conexão falhou: ${pingErro ?? 'erro desconhecido'}. Tente sincronizar mesmo assim — o endpoint de ping pode ser diferente do de produtos.`,
    });

  } catch (error) {
    logger.error('settings', 'Erro ao salvar credenciais WMS', { erro: String(error) });
    res.status(500).json({ sucesso: false, erro: String(error) });
  }
}
