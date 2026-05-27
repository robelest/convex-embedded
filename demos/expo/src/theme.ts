export const colors = {
  accent: {
    300: "#e8a070",
    400: "#d4764a",
    500: "#c25d3a",
    600: "#a34a2a",
  },
  warm: {
    50: "#fdfcfa",
    100: "#faf8f5",
    200: "#f5f2ed",
    300: "#e8e2d8",
    400: "#b5aea3",
    500: "#8c8780",
    600: "#6b665f",
    700: "#4a453e",
    800: "#2d2a26",
    900: "#1a1816",
  },
  success: "#16a34a",
  urgent: "#991b1b",
  white: "#ffffff",
} as const;

export const priorityColors = {
  none: {
    bg: colors.warm[50],
    text: colors.warm[500],
    border: colors.warm[200],
  },
  urgent: { bg: "#fef2f2", text: "#7f1d1d", border: "#fecaca" },
  high: { bg: "#fff7ed", text: "#7c2d12", border: "#fed7aa" },
  medium: { bg: "#fffbeb", text: "#854d0e", border: "#fde68a" },
  low: {
    bg: colors.warm[100],
    text: colors.warm[600],
    border: colors.warm[300],
  },
} as const;

export const statusColors = {
  in_progress: colors.accent[500],
  todo: colors.warm[500],
  backlog: colors.warm[400],
  done: colors.success,
  cancelled: colors.warm[300],
} as const;

