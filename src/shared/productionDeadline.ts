export function internalPostingDay(shipDay: string): string {
  const [year, month, day] = shipDay.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() === 1 ? 2 : 1))
  return date.toISOString().slice(0, 10)
}
