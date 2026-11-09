const button = document.getElementById('connect')
const status = document.getElementById('status')

void chrome.cookies.getAll({}).then((cookies) => {
  status.textContent = cookies.some((cookie) =>
    cookie.name === 'SPC_CDS' && /(^|\.)shopee\.com\.br$/i.test(cookie.domain) && cookie.value
  ) ? 'Sessão de sincronização encontrada neste perfil.' : 'Sessão de sincronização indisponível neste perfil.'
}).catch(() => {
  status.textContent = 'Não foi possível verificar a sessão da Shopee.'
})

button.addEventListener('click', async () => {
  button.disabled = true
  status.textContent = 'Verificando aplicativo…'
  try {
    // A primeira conexão parte de uma página visível, para que o Chrome possa
    // conceder acesso à rede local antes das verificações em segundo plano.
    const response = await fetch('http://127.0.0.1:17384/status', {
      headers: { 'X-CRM-Bridge': 'shopee-session-v1' }, cache: 'no-store'
    })
    if (!response.ok) throw new Error('O aplicativo recusou a conexão local.')
    const { requestId } = await response.json()
    if (!requestId) {
      status.textContent = 'O aplicativo está aberto, mas não está aguardando a sessão. Clique em “Usar login do Chrome” no CRM Seller e tente aqui novamente.'
      return
    }
    const cookies = (await chrome.cookies.getAll({})).filter((cookie) =>
      /(^|\.)shopee\.com\.br$/i.test(cookie.domain)
    )
    if (!cookies.some((cookie) => cookie.name === 'SPC_CDS' && cookie.value)) {
      status.textContent = 'O Chrome não liberou o cookie de sincronização. Recarregue a extensão e a página do Seller Center neste perfil.'
      return
    }
    const result = await fetch('http://127.0.0.1:17384/session', {
      method: 'POST',
      headers: {
        'X-CRM-Bridge': 'shopee-session-v1',
        'X-CRM-Request-Id': requestId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ cookies, userAgent: navigator.userAgent })
    })
    if (!result.ok) {
      const failure = await result.json()
      status.textContent = failure.error || 'Não foi possível usar a sessão da Shopee.'
      return
    }
    status.textContent = 'Sessão conectada. Confira o aplicativo.'
  } catch {
    status.textContent = 'Não foi possível acessar o aplicativo. Deixe-o aberto e autorize o acesso à rede local se o Chrome pedir.'
  } finally {
    button.disabled = false
  }
})
