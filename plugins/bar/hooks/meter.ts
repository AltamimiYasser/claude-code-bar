// The bar's drawings on the desktop: SVG the app draws as images. The app
// sets each SVG's `color` to its text colour, so `currentColor` is a light
// line on a dark theme and a dark one on a light theme. Plain functions with
// no `$`, so a test can call them.
//
// One language throughout: a hairline track, a fill that brightens toward
// its end, and a bead (the level's colour with a white heart) at the tip.

// The level colours, as mid-tones that read on a light and a dark background
// alike; the panel and the pills use the same ones.
export const LEVEL_RGB: Record<string, string> = {
  success: '34, 160, 90',
  warning: '202, 138, 4',
  claude: '217, 119, 87',
  error: '220, 38, 38',
}

const rgbOf = (level: string) => `rgb(${LEVEL_RGB[level] ?? LEVEL_RGB.success})`

const clamp = (n: number) => Math.min(Math.max(n, 0), 1)

const svg = (width: string, height: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`

// The fill's gradient and the bead's glow.
const defs = (rgb: string) =>
  '<defs>' +
  `<linearGradient id="fill"><stop offset="0" stop-color="${rgb}" stop-opacity="0.15"/><stop offset="1" stop-color="${rgb}"/></linearGradient>` +
  '<filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2"/></filter>' +
  '</defs>'

// The bead at a point: glow, body, white heart. Positions go in `style`,
// where the browser resolves `calc()`, which a stretched width needs.
const bead = (cx: string, cy: string, rgb: string) =>
  `<circle style="cx:${cx};cy:${cy}" r="5" fill="${rgb}" fill-opacity="0.5" filter="url(#glow)"/>` +
  `<circle style="cx:${cx};cy:${cy}" r="3" fill="${rgb}"/>` +
  `<circle style="cx:${cx};cy:${cy}" r="1.2" fill="#fff" fill-opacity="0.9"/>`

export type MeterOptions = {
  // Shares where a faint tick marks the next colour; only those still ahead
  // of the fill are drawn, since a passed one would cut through it.
  ticks?: number[]
  // How much of a usage window has passed: a "now" mark on the track. Fill
  // past it means usage is running ahead of the clock.
  cursor?: number | null
  // Room kept at either end for the bead and its glow, in CSS pixels.
  pad?: number
}

// The line meter: stretches to the room it is given.
export function meterSvg(ratio: number, level: string, options: MeterOptions | number[] = {}) {
  const { ticks = [], cursor = null, pad = 6 } = Array.isArray(options) ? { ticks: options } : options
  const share = clamp(ratio)
  const rgb = rgbOf(level)
  const along = (at: number) => `calc(${pad}px + (100% - ${2 * pad}px) * ${at})`
  const tickMarks = ticks
    .filter(tick => tick > share && tick < 1)
    .map(
      tick =>
        `<rect style="x:calc(${along(tick)} - 0.5px);y:calc(50% - 3px);width:1px;height:6px" rx="0.5" fill="currentColor" fill-opacity="0.28"/>`,
    )
    .join('')
  const now =
    cursor === null
      ? ''
      : `<rect style="x:calc(${along(clamp(cursor))} - 0.75px);y:calc(50% - 5px);width:1.5px;height:10px" rx="0.75" fill="currentColor" fill-opacity="0.6"/>`
  const fill =
    share > 0
      ? `<rect style="x:${pad}px;y:calc(50% - 1.5px);width:calc((100% - ${2 * pad}px) * ${share});height:3px" rx="1.5" fill="url(#fill)"/>` +
        bead(along(share), '50%', rgb)
      : ''

  return svg(
    '100%',
    '100%',
    defs(rgb) +
      `<rect style="x:${pad}px;y:calc(50% - 0.5px);width:calc(100% - ${2 * pad}px);height:1px" rx="0.5" fill="currentColor" fill-opacity="0.2"/>` +
      tickMarks +
      now +
      fill,
  )
}

// While Claude works: the bead with a ring that swells once a second. The
// bar redraws each second while a turn runs, so the beat keeps time with
// the timer beside it.
export const pulseSvg = (level: string) => {
  const rgb = rgbOf(level)

  return svg(
    '14',
    '14',
    `<circle cx="7" cy="7" r="3" fill="none" stroke="${rgb}" stroke-width="1.5">` +
      '<animate attributeName="r" values="3;6.5" dur="1s" repeatCount="indefinite"/>' +
      '<animate attributeName="stroke-opacity" values="0.7;0" dur="1s" repeatCount="indefinite"/>' +
      '</circle>' +
      `<circle cx="7" cy="7" r="4" fill="${rgb}" fill-opacity="0.35"/>` +
      `<circle cx="7" cy="7" r="3" fill="${rgb}"/>` +
      '<circle cx="7" cy="7" r="1.2" fill="#fff" fill-opacity="0.9"/>',
  )
}

// Between turns: an empty ring, the bead at rest.
export const restingSvg = () =>
  svg('14', '14', '<circle cx="7" cy="7" r="3" fill="none" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5"/>')

// Output tokens a second across the running turn, oldest first, ending in
// the bead. Fewer than two samples draw nothing.
export function sparkSvg(values: number[], level: string, width = 72, height = 16) {
  if (values.length < 2) {
    return null
  }

  const rgb = rgbOf(level)
  const max = Math.max(...values, 1)
  const points = values.map(
    (value, index) => [(index / (values.length - 1)) * (width - 6) + 1, height - 2 - (value / max) * (height - 5)] as const,
  )
  const path = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const [lastX, lastY] = points[points.length - 1] ?? [0, 0]

  return svg(
    String(width),
    String(height),
    '<defs>' +
      `<linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${rgb}" stop-opacity="0.35"/><stop offset="1" stop-color="${rgb}" stop-opacity="0"/></linearGradient>` +
      '<filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.5"/></filter>' +
      '</defs>' +
      `<path d="${path} L${lastX.toFixed(1)} ${height} L1 ${height} Z" fill="url(#area)"/>` +
      `<path d="${path}" fill="none" stroke="${rgb}" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4" fill="${rgb}" fill-opacity="0.5" filter="url(#glow)"/>` +
      `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.2" fill="${rgb}"/>`,
  )
}

// The hairline between segments.
export const ruleSvg = () => svg('1', '16', '<rect width="1" height="16" fill="currentColor" fill-opacity="0.16"/>')

// The hairline between the rows.
export const hruleSvg = () => svg('100%', '1', '<rect width="100%" height="1" fill="currentColor" fill-opacity="0.1"/>')
