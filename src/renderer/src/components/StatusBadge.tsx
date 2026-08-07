import type { InternalStatus } from '@shared/types'
import { INTERNAL_STATUS_LABELS } from '@shared/types'

export function StatusBadge({ status }: { status: InternalStatus }): React.JSX.Element {
  return <span className={`badge st-${status}`}>{INTERNAL_STATUS_LABELS[status]}</span>
}
