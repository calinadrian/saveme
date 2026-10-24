import { RetentionPolicy } from './types'

export function validateRetention(value: RetentionPolicy): void {
  if (!value || typeof value !== 'object') throw new Error('Enter a valid version history policy')
  for (const key of ['keepLast', 'keepDaily', 'keepWeekly'] as const) {
    const min = key === 'keepLast' ? (value.keepDaily === 0 && value.keepWeekly === 0 ? 2 : 1) : 0
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > 365) {
      throw new Error(`${key === 'keepLast' ? 'Latest versions' : key === 'keepDaily' ? 'Daily history' : 'Weekly history'} must be a whole number from ${min} to 365`)
    }
  }
}
