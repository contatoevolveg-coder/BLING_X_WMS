const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout
});

const ask = (question) => new Promise((resolve) => readline.question(question, resolve));

async function run() {
  console.log('=============================================');
  console.log('  PAINEL RÁPIDO DE CONFIGURAÇÃO DO WMS       ');
  console.log('=============================================\n');

  const vercelUrl = await ask('1. Digite a URL base do seu projeto na Vercel (ex: https://bling-x-wms-xyz.vercel.app): ');
  const cronSecret = await ask('2. Digite o seu CRON_SECRET: ');
  const wmsApiKey = await ask('3. Digite a API_KEY do WMS: ');
  const depositante = await ask('4. Digite o CNPJ/ID do Depositante: ');
  const wmsBaseUrl = await ask('5. Qual a URL do WMS? (Aperte Enter para usar "https://apigateway.smartgo.com.br"): ');

  const finalWmsUrl = wmsBaseUrl.trim() === '' ? 'https://apigateway.smartgo.com.br' : wmsBaseUrl.trim();
  const targetApi = `${vercelUrl.replace(/\/$/, '')}/api/settings/config`;

  console.log('\nEnviando configuração e testando a conexão. Por favor aguarde...\n');

  try {
    const response = await fetch(targetApi, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cronSecret.trim()}`
      },
      body: JSON.stringify({
        wms_api_key: wmsApiKey.trim(),
        wms_base_url: finalWmsUrl,
        wms_doc_depositante: depositante.trim()
      })
    });

    const data = await response.json();

    if (response.ok) {
      console.log('✅ SUCESSO!');
      console.log('Mensagem do servidor:', data.mensagem);
    } else {
      console.log('❌ FALHA AO CONFIGURAR!');
      console.log('Erro retornado:', data.erro);
      if (data.detalhes) console.log('Detalhes:', data.detalhes);
    }
  } catch (error) {
    console.log('❌ ERRO FATAL: Não foi possível alcançar o servidor. Verifique se a URL da Vercel está correta e tente novamente.');
    console.log(error.message);
  }

  readline.close();
}

run();
