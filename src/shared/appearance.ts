import type { Appearance, ResolvedTheme } from './types'

export function validateAppearance(value: unknown): asserts value is Appearance {
  if (value !== 'dark' && value !== 'light' && value !== 'system') throw new Error('Choose Dark, Light, or System appearance')
}

export function resolveTheme(appearance: Appearance, systemDark: boolean): ResolvedTheme {
  return appearance === 'system' ? (systemDark ? 'dark' : 'light') : appearance
}

export const WINDOW_COLORS = {
  dark: { color: '#0c0e11', symbolColor: '#b9bec8', height: 40 },
  light: { color: '#f1f3f5', symbolColor: '#404854', height: 40 }
} as const
