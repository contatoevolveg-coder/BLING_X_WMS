import { getSupabase } from './supabase';

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const settingsCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

/**
 * Busca uma configuração do sistema (ex: API Keys) da tabela `system_settings`.
 * Possui cache em memória para evitar sobrecarga no banco de dados e
 * fallback automático para variáveis de ambiente (process.env) caso não exista no DB.
 * 
 * @param key A chave de configuração (ex: 'WMS_API_KEY')
 * @returns O valor da configuração em string
 * @throws Error se a configuração não existir nem no banco nem no env
 */
export async function getSetting(key: string): Promise<string> {
  const now = Date.now();
  const cached = settingsCache.get(key);

  // Retorna do cache se ainda for válido
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  // Busca do banco de dados (Supabase)
  const db = getSupabase();
  const { data, error } = await db
    .from('system_settings')
    .select('value')
    .eq('key', key)
    .single();

  if (!error && data?.value) {
    settingsCache.set(key, { value: data.value, expiresAt: now + CACHE_TTL_MS });
    return data.value;
  }

  // Fallback: Busca da variável de ambiente caso o banco falhe ou não tenha a chave
  const envVal = process.env[key];
  if (envVal) {
    return envVal;
  }

  throw new Error(`Configuração obrigatória não encontrada: ${key}`);
}

/**
 * Atualiza ou insere uma configuração no banco de dados e atualiza o cache local.
 * 
 * @param key A chave de configuração (ex: 'WMS_API_KEY')
 * @param value O valor correspondente
 */
export async function setSetting(key: string, value: string): Promise<void> {
  const db = getSupabase();
  const { error } = await db
    .from('system_settings')
    .upsert(
      { key, value, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );

  if (error) {
    throw new Error(`Falha ao salvar configuração ${key}: ${error.message}`);
  }

  // Atualiza o cache imediatamente
  settingsCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}
