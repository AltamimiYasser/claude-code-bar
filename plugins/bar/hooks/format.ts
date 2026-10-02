// Theme keys, so the engine picks the light or dark shade of each colour
// from the active theme, including when the theme follows the system. The
// share of a limit where each colour starts is a setting (`levels`).
type Levels = { yellow: number; orange: number; red: number }

export const colorFor = (ratio: number, levels: Levels = { yellow: 0.5, orange: 0.75, red: 1 }) =>
  ratio >= levels.red
    ? 'error'
    : ratio >= levels.orange
      ? 'claude'
      : ratio >= levels.yellow
        ? 'warning'
        : 'success'

const pad = (n: number) => String(n).padStart(2, '0')

export const clockTime = (ms: number, withSeconds = true) => {
  const date = new Date(ms)
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`

  return withSeconds ? `${hm}:${pad(date.getSeconds())}` : hm
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// The full reset moment: `Sun 5 Oct, 21:34`.
export const longDate = (ms: number) => {
  const date = new Date(ms)

  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}, ${clockTime(ms, false)}`
}

// How long until a moment, coarse: `2d 3h`, `1h 59m`, `12m`.
export const until = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  return days > 0
    ? `${days}d ${hours % 24}h`
    : hours > 0
      ? `${hours}h ${minutes % 60}m`
      : `${minutes}m`
}

// When a window resets: a clock time today, else the weekday.
export const resetTime = (resetsAt: string, now: number) => {
  const at = Date.parse(resetsAt)
  const isToday = new Date(at).toDateString() === new Date(now).toDateString()

  return isToday
    ? clockTime(at, false)
    : (DAYS[new Date(at).getDay()] ?? '')
}


export const shortCount = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `${Math.round(n / 1_000)}k`
      : n >= 1_000
        ? `${(n / 1_000).toFixed(1)}k`
        : `${n}`

// A duration the way Claude Code writes one: `8s`, `1m 4s`, `1h 2m`.
export const duration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  return hours > 0
    ? `${hours}h ${minutes % 60}m`
    : minutes > 0
      ? `${minutes}m ${seconds % 60}s`
      : `${seconds}s`
}
