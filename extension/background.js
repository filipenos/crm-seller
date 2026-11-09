const BRIDGE = 'http://127.0.0.1:17384'
const HEADERS = { 'X-CRM-Bridge': 'shopee-session-v1' }
let sending = false

async function shareWhenRequested() {
  if (sending) return
  sending = true
  try {
    const statusResponse = await fetch(`${BRIDGE}/status`, { headers: HEADERS, cache: 'no-store' })
    if (!statusResponse.ok) return
    const { requestId } = await statusResponse.json()
    if (!requestId) return
    const cookies = (await chrome.cookies.getAll({})).filter((cookie) =>
      /(^|\.)shopee\.com\.br$/i.test(cookie.domain)
    )
    if (!cookies.some((cookie) => cookie.name === 'SPC_CDS' && cookie.value)) return
    const response = await fetch(`${BRIDGE}/session`, {
      method: 'POST',
      headers: { ...HEADERS, 'X-CRM-Request-Id': requestId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies, userAgent: navigator.userAgent })
    })
    if (!response.ok) {
      const result = await response.json()
      console.warn('CRM Seller:', result.error || 'Não foi possível usar a sessão do Chrome.')
    }
  } catch {
    // O aplicativo pode estar fechado. A próxima verificação tenta de novo.
  } finally {
    sending = false
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create('crm-seller-session', { periodInMinutes: 0.5 })
  void shareWhenRequested()
})
chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create('crm-seller-session', { periodInMinutes: 0.5 })
  void shareWhenRequested()
})
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'crm-seller-session') void shareWhenRequested()
})
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'share-session') void shareWhenRequested()
})
void shareWhenRequested()
