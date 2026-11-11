import { useEffect, useState } from 'react'
import type { ProgressoLote } from '@shared/types'

/**
 * Progresso das operações longas (rastreios, extratos).
 *
 * São centenas de requisições que levam minutos: sem retorno visível o usuário
 * não sabe se travou, e sem "Parar" fica refém do fim.
 */
export default function BarraProgresso(): React.JSX.Element | null {
  const [p, setP] = useState<ProgressoLote | null>(null)

  useEffect(() => {
    void window.api.lote.progresso().then(setP)
    return window.api.lote.onProgresso(setP)
  }, [])

  if (!p?.rodando) return null

  const pct = p.total > 0 ? Math.round((p.feitos / p.total) * 100) : 0
  const rotulos: Record<string, string> = {
    pedidos: 'Sincronizando pedidos',
    gravando: 'Conferindo pedidos no banco',
    datas: 'Conferindo datas das vendas',
    etiquetas: 'Atualizando datas das etiquetas',
    rastreios: 'Sincronizando rastreios',
    historico: 'Completando histórico logístico',
    pagamentos: 'Sincronizando pagamentos',
    finalizando: 'Finalizando sincronização'
  }
  const rotulo = rotulos[p.rotulo] ?? 'Sincronizando'

  return (
    <div className="barra-progresso">
      <div className="barra-trilho">
        <div className="barra-preenchida" style={{ width: `${pct}%` }} />
      </div>
      <span>
        {rotulo}{p.total > 0 ? `: ${p.feitos} de ${p.total}` : '…'}
      </span>
      <button className="dismiss" onClick={() => void window.api.lote.cancelar()}>
        Parar
      </button>
    </div>
  )
}
