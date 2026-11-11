import type { ProgressoLote } from '@shared/types'

interface Props {
  progress: ProgressoLote | null
  starting: boolean
}

const LABELS: Record<string, string> = {
  pedidos: 'Sincronizando pedidos',
  gravando: 'Conferindo pedidos no banco',
  datas: 'Conferindo datas das vendas',
  etiquetas: 'Atualizando datas das etiquetas',
  rastreios: 'Atualizando rastreios',
  historico: 'Completando histórico logístico',
  pagamentos: 'Atualizando pagamentos',
  finalizando: 'Finalizando sincronização'
}

export default function OrdersSyncPage({ progress, starting }: Props): React.JSX.Element {
  const running = Boolean(progress?.rodando)
  const percent = running && progress!.total > 0
    ? Math.min(100, Math.round((progress!.feitos / progress!.total) * 100))
    : null
  const title = running ? (LABELS[progress!.rotulo] ?? 'Sincronizando') : 'Preparando sincronização'

  return <div className="orders-sync-screen">
    <div className="orders-sync-card">
      <div className="orders-sync-spinner" aria-hidden="true" />
      <h1>{title}</h1>
      <p>A lista de pedidos será carregada quando a sincronização terminar.</p>
      {running && <p className="muted">
        {progress!.novos} novos
        {progress!.rastreiosPendentes !== null && ` · ${progress!.rastreiosPendentes} rastreios a consultar`}
        {progress!.recebimentosPendentes !== null && ` · ${progress!.recebimentosPendentes} recebimentos a consultar`}
      </p>}
      {percent !== null ? <>
        <div className="orders-sync-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div style={{ width: `${percent}%` }} />
        </div>
        <strong>{progress!.feitos.toLocaleString('pt-BR')} de {progress!.total.toLocaleString('pt-BR')} — {percent}%</strong>
      </> : <span className="muted">{progress?.rotulo === 'finalizando' ? 'Atualizando catálogo…' : starting ? 'Iniciando…' : 'Aguardando progresso…'}</span>}
      {running && <button onClick={() => void window.api.lote.cancelar()}>Parar sincronização</button>}
    </div>
  </div>
}
