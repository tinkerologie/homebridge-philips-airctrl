export function airQualityFromPm25(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  if (value <= 12) return 1
  if (value <= 35) return 2
  if (value <= 55) return 3
  if (value <= 150) return 4
  return 5
}

export function rotationSpeedFromMode(mode: unknown, speedCount: number): number {
  if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 1 || mode > speedCount) return 0
  return (mode * 100) / speedCount
}

export function modeFromRotationSpeed(speed: number, speedCount: number): number | null {
  if (!Number.isFinite(speed) || !Number.isInteger(speedCount) || speedCount < 1 || speed <= 0)
    return null
  return Math.min(speedCount, Math.max(1, Math.round((speed * speedCount) / 100)))
}

export function filterLifePercent(remaining: unknown, total: unknown): number {
  if (
    typeof remaining !== 'number' ||
    typeof total !== 'number' ||
    !Number.isFinite(remaining) ||
    !Number.isFinite(total) ||
    total <= 0
  )
    return 0
  return Math.min(100, Math.max(0, Math.round((remaining / total) * 100)))
}

export const beepValue = (value: boolean): number => (value ? 100 : 0)
export const lampValue = (value: boolean): number => (value ? 1 : 0)
export const booleanValue = (value: boolean): number => (value ? 1 : 0)
export const booleanFromValue = (value: unknown): boolean =>
  typeof value === 'number' && value !== 0
export const beepFromValue = booleanFromValue
export const lampFromValue = booleanFromValue
export const temperatureFromRaw = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value / 10 : 0
