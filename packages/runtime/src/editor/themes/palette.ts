/**
 * Built-in theme color tables.
 *
 * Deliberately free of registry state — no Map, no listeners, no active theme.
 * Importing this module runs nothing but two object literals, so hosts that
 * only need the palette (the web console) can take the colors without also
 * booting the desktop theme registry and its `@nimbalyst/extension-sdk` edge.
 * `registry.ts` is the only consumer that layers mutable state on top.
 */

import type { ExtendedThemeColors } from './types';

/**
 * Built-in light theme colors.
 */
export const lightThemeColors: ExtendedThemeColors = {
  // Backgrounds
  'bg': '#ffffff',
  'bg-secondary': '#f7f8fa',
  'bg-tertiary': '#eef0f4',
  'bg-hover': 'rgba(24, 32, 52, 0.05)',
  'bg-selected': 'rgba(53, 99, 233, 0.09)',
  'bg-active': 'rgba(53, 99, 233, 0.15)',

  // Text
  'text': '#202532',
  'text-muted': '#626b7c',
  'text-faint': '#6c7586',
  'text-disabled': '#a5adba',

  // Borders
  'border': '#e1e4ea',
  'border-focus': '#3563e9',

  // Primary
  'primary': '#3563e9',
  'primary-hover': '#284fc7',
  'on-primary': '#ffffff',

  // Links
  'link': '#315bd6',
  'link-hover': '#2447b3',

  // Status
  'success': '#10b981',
  'warning': '#f59e0b',
  'error': '#ef4444',
  'info': '#3563e9',
  'purple': '#7c3aed',

  // Code
  'code-bg': '#f3f5f8',
  'code-text': '#202532',
  'code-border': '#e1e4ea',
  'code-gutter': '#eef0f4',

  // Table
  'table-border': '#e1e4ea',
  'table-header': '#f3f5f8',
  'table-cell': '#ffffff',
  'table-stripe': '#f7f8fa',

  // Toolbar
  'toolbar-bg': '#ffffff',
  'toolbar-border': '#e1e4ea',
  'toolbar-hover': '#eef0f4',
  'toolbar-active': 'rgba(53, 99, 233, 0.15)',

  // Special
  'highlight-bg': 'rgba(255, 212, 0, 0.14)',
  'highlight-border': 'rgba(255, 212, 0, 0.3)',
  'comment-mark': '#ffd400',
  'quote-text': '#626b7c',
  'quote-border': '#d2d8e2',

  // Scrollbar
  'scrollbar-thumb': '#cbd1dc',
  'scrollbar-thumb-hover': '#a5adba',
  'scrollbar-track': 'transparent',

  // Diff
  'diff-add-bg': '#e6ffed',
  'diff-add-border': '#e6ffed',
  'diff-remove-bg': '#ffebe9',
  'diff-remove-border': '#ffebe9',

  // Syntax highlighting
  'code-comment': 'slategray',
  'code-punctuation': '#999',
  'code-property': '#905',
  'code-selector': '#690',
  'code-operator': '#9a6e3a',
  'code-attr': '#07a',
  'code-variable': '#e90',
  'code-function': '#dd4a68',

  // Terminal
  'terminal-bg': '#ffffff',
  'terminal-fg': '#202532',
  'terminal-cursor': '#3563e9',
  'terminal-cursor-accent': '#ffffff',
  'terminal-selection': 'rgba(53, 99, 233, 0.15)',

  // Terminal ANSI standard colors (optimized for light background)
  'terminal-ansi-black': '#1f2937',
  'terminal-ansi-red': '#dc2626',
  'terminal-ansi-green': '#16a34a',
  'terminal-ansi-yellow': '#ca8a04',
  'terminal-ansi-blue': '#2563eb',
  'terminal-ansi-magenta': '#9333ea',
  'terminal-ansi-cyan': '#0891b2',
  'terminal-ansi-white': '#f3f4f6',

  // Terminal ANSI bright colors
  'terminal-ansi-bright-black': '#6b7280',
  'terminal-ansi-bright-red': '#ef4444',
  'terminal-ansi-bright-green': '#22c55e',
  'terminal-ansi-bright-yellow': '#eab308',
  'terminal-ansi-bright-blue': '#3b82f6',
  'terminal-ansi-bright-magenta': '#a855f7',
  'terminal-ansi-bright-cyan': '#06b6d4',
  'terminal-ansi-bright-white': '#ffffff',
};

/**
 * Built-in dark theme colors.
 */
export const darkThemeColors: ExtendedThemeColors = {
  // Backgrounds
  'bg': '#232428',
  'bg-secondary': '#191a1d',
  'bg-tertiary': '#2c2e34',
  'bg-hover': 'rgba(237, 239, 245, 0.06)',
  'bg-selected': 'rgba(138, 164, 255, 0.14)',
  'bg-active': 'rgba(138, 164, 255, 0.22)',

  // Text
  'text': '#edeef2',
  'text-muted': '#adb0bc',
  'text-faint': '#858a9a',
  'text-disabled': '#606574',

  // Borders
  'border': '#373a43',
  'border-focus': '#8aa4ff',

  // Primary
  'primary': '#8aa4ff',
  'primary-hover': '#a4b8ff',
  'on-primary': '#151a2b',

  // Links
  'link': '#9ab1ff',
  'link-hover': '#bdcbff',

  // Status
  'success': '#4ade80',
  'warning': '#fbbf24',
  'error': '#ef4444',
  'info': '#8aa4ff',
  'purple': '#a78bfa',

  // Code
  'code-bg': '#1c1d21',
  'code-text': '#edeef2',
  'code-border': '#373a43',
  'code-gutter': '#282a30',

  // Table
  'table-border': '#373a43',
  'table-header': '#2c2e34',
  'table-cell': '#232428',
  'table-stripe': '#27292e',

  // Toolbar
  'toolbar-bg': '#232428',
  'toolbar-border': '#373a43',
  'toolbar-hover': '#2c2e34',
  'toolbar-active': 'rgba(138, 164, 255, 0.22)',

  // Special
  'highlight-bg': 'rgba(255, 212, 0, 0.2)',
  'highlight-border': 'rgba(255, 212, 0, 0.4)',
  // Warmer, lighter gold reads as an intentional highlight on dark backgrounds
  // instead of the muddy olive that saturated yellow blends into.
  'comment-mark': '#ffd27a',
  'quote-text': '#adb0bc',
  'quote-border': '#373a43',

  // Scrollbar
  'scrollbar-thumb': '#424650',
  'scrollbar-thumb-hover': '#5b6170',
  'scrollbar-track': 'transparent',

  // Diff
  'diff-add-bg': 'rgba(40, 167, 69, 0.15)',
  'diff-add-border': 'rgba(40, 167, 69, 0.4)',
  'diff-remove-bg': 'rgba(220, 53, 69, 0.15)',
  'diff-remove-border': 'rgba(220, 53, 69, 0.4)',

  // Syntax highlighting
  'code-comment': '#6a9955',
  'code-punctuation': '#cccccc',
  'code-property': '#9cdcfe',
  'code-selector': '#d7ba7d',
  'code-operator': '#d4d4d4',
  'code-attr': '#92c5f8',
  'code-variable': '#4fc1ff',
  'code-function': '#dcdcaa',

  // Terminal
  'terminal-bg': '#191a1d',
  'terminal-fg': '#edeef2',
  'terminal-cursor': '#8aa4ff',
  'terminal-cursor-accent': '#191a1d',
  'terminal-selection': 'rgba(138, 164, 255, 0.22)',

  // Terminal ANSI standard colors (Tailwind palette)
  'terminal-ansi-black': '#000000',
  'terminal-ansi-red': '#ef4444',
  'terminal-ansi-green': '#22c55e',
  'terminal-ansi-yellow': '#eab308',
  'terminal-ansi-blue': '#3b82f6',
  'terminal-ansi-magenta': '#a855f7',
  'terminal-ansi-cyan': '#06b6d4',
  'terminal-ansi-white': '#ffffff',

  // Terminal ANSI bright colors
  'terminal-ansi-bright-black': '#6b7280',
  'terminal-ansi-bright-red': '#f87171',
  'terminal-ansi-bright-green': '#4ade80',
  'terminal-ansi-bright-yellow': '#facc15',
  'terminal-ansi-bright-blue': '#60a5fa',
  'terminal-ansi-bright-magenta': '#c084fc',
  'terminal-ansi-bright-cyan': '#22d3ee',
  'terminal-ansi-bright-white': '#ffffff',
};

/**
 * Get the base theme colors for a given dark mode preference.
 * Used for merging extension theme contributions with base colors.
 */
export function getBaseThemeColors(isDark: boolean): ExtendedThemeColors {
  return isDark ? darkThemeColors : lightThemeColors;
}
