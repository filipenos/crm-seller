import type { ProgressoLote } from '@shared/types'

interface Props {
  progress: ProgressoLote | null
  starting: boolean
}

const LABELS: Record<string, string> = {
  pedidos: 'Sincronizando pedidos',
  rastreios: 'Atualizando rastreios',
  pagamentos: 'Atualizando pagamentos'
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
      {percent !== null ? <>
        <div className="orders-sync-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div style={{ width: `${percent}%` }} />
        </div>
        <strong>{progress!.feitos.toLocaleString('pt-BR')} de {progress!.total.toLocaleString('pt-BR')} — {percent}%</strong>
      </> : <span className="muted">{starting ? 'Iniciando…' : 'Aguardando progresso…'}</span>}
      {running && <button onClick={() => void window.api.lote.cancelar()}>Parar sincronização</button>}
    </div>
  </div>
}
