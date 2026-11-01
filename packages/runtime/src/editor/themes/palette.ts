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
  'bg-secondary': '#f8f8fa',
  'bg-tertiary': '#f0f0f3',
  'bg-hover': 'rgba(36, 37, 43, 0.045)',
  'bg-selected': 'rgba(94, 106, 210, 0.09)',
  'bg-active': 'rgba(94, 106, 210, 0.15)',

  // Text
  'text': '#24252b',
  'text-muted': '#656671',
  'text-faint': '#72737e',
  'text-disabled': '#a6a7b0',

  // Borders
  'border': '#e5e5e9',
  'border-focus': '#5e6ad2',

  // Primary
  'primary': '#5e6ad2',
  'primary-hover': '#515dbe',
  'on-primary': '#ffffff',

  // Links
  'link': '#535fc4',
  'link-hover': '#454fab',

  // Status
  'success': '#10b981',
  'warning': '#f59e0b',
  'error': '#ef4444',
  'info': '#5e6ad2',
  'purple': '#7c3aed',

  // Code
  'code-bg': '#f5f5f7',
  'code-text': '#24252b',
  'code-border': '#e5e5e9',
  'code-gutter': '#f0f0f3',

  // Table
  'table-border': '#e5e5e9',
  'table-header': '#f5f5f7',
  'table-cell': '#ffffff',
  'table-stripe': '#f8f8fa',

  // Toolbar
  'toolbar-bg': '#ffffff',
  'toolbar-border': '#e5e5e9',
  'toolbar-hover': '#f0f0f3',
  'toolbar-active': 'rgba(94, 106, 210, 0.15)',

  // Special
  'highlight-bg': 'rgba(255, 212, 0, 0.14)',
  'highlight-border': 'rgba(255, 212, 0, 0.3)',
  'comment-mark': '#ffd400',
  'quote-text': '#656671',
  'quote-border': '#d8d8df',

  // Scrollbar
  'scrollbar-thumb': '#d1d1d9',
  'scrollbar-thumb-hover': '#a6a7b0',
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
  'terminal-fg': '#24252b',
  'terminal-cursor': '#5e6ad2',
  'terminal-cursor-accent': '#ffffff',
  'terminal-selection': 'rgba(94, 106, 210, 0.15)',

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
  'bg': '#17181b',
  'bg-secondary': '#121316',
  'bg-tertiary': '#222328',
  'bg-hover': 'rgba(238, 239, 244, 0.055)',
  'bg-selected': 'rgba(126, 137, 230, 0.14)',
  'bg-active': 'rgba(126, 137, 230, 0.22)',

  // Text
  'text': '#eeeff4',
  'text-muted': '#a5a7b3',
  'text-faint': '#858795',
  'text-disabled': '#585b69',

  // Borders
  'border': '#2c2d34',
  'border-focus': '#8b95ee',

  // Primary
  'primary': '#7e88e6',
  'primary-hover': '#8b94ef',
  'on-primary': '#121316',

  // Links
  'link': '#a1a9f4',
  'link-hover': '#c1c6ff',

  // Status
  'success': '#4ade80',
  'warning': '#fbbf24',
  'error': '#ef4444',
  'info': '#a1a9f4',
  'purple': '#a78bfa',

  // Code
  'code-bg': '#141518',
  'code-text': '#eeeff4',
  'code-border': '#2c2d34',
  'code-gutter': '#1d1e23',

  // Table
  'table-border': '#2c2d34',
  'table-header': '#222328',
  'table-cell': '#17181b',
  'table-stripe': '#1b1c20',

  // Toolbar
  'toolbar-bg': '#17181b',
  'toolbar-border': '#2c2d34',
  'toolbar-hover': '#222328',
  'toolbar-active': 'rgba(126, 137, 230, 0.22)',

  // Special
  'highlight-bg': 'rgba(255, 212, 0, 0.2)',
  'highlight-border': 'rgba(255, 212, 0, 0.4)',
  // Warmer, lighter gold reads as an intentional highlight on dark backgrounds
  // instead of the muddy olive that saturated yellow blends into.
  'comment-mark': '#ffd27a',
  'quote-text': '#a5a7b3',
  'quote-border': '#2c2d34',

  // Scrollbar
  'scrollbar-thumb': '#373940',
  'scrollbar-thumb-hover': '#4c4f59',
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
  'terminal-bg': '#121316',
  'terminal-fg': '#eeeff4',
  'terminal-cursor': '#7e88e6',
  'terminal-cursor-accent': '#121316',
  'terminal-selection': 'rgba(126, 137, 230, 0.22)',

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
