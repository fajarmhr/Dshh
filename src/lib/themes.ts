/**
 * Built-in terminal colour schemes.
 *
 * MobaXterm ships a palette list and can import iTerm2 `.itermcolors` files;
 * these are the schemes people actually reach for, transcribed to xterm.js's
 * `ITheme` shape. Only the id is persisted, so a palette can be retuned in a
 * later release without migrating anyone's settings.
 */

export interface TerminalTheme {
  id: string;
  label: string;
  /** Shown as a swatch strip in the picker: bg, then a few signature hues. */
  preview: string[];
  colors: {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
}

const THEME_LIST: TerminalTheme[] = [
  {
    id: "dshh",
    label: "Dshh",
    preview: ["#070a0f", "#66a2ff", "#34e08d", "#ffb454"],
    colors: {
      // Slightly more saturated than the app chrome so coloured output (ls,
      // htop, log levels) reads vividly — without neon-poster territory.
      background: "#070a0f",
      foreground: "#dde6f0",
      cursor: "#5b8cff",
      cursorAccent: "#070a0f",
      selectionBackground: "#2a3550",
      black: "#0a0e14",
      red: "#ff6e78",
      green: "#34e08d",
      yellow: "#ffb454",
      blue: "#66a2ff",
      magenta: "#c58fff",
      cyan: "#3fd5f0",
      white: "#dde6f0",
      brightBlack: "#6b7a8c",
      brightRed: "#ff98a0",
      brightGreen: "#6ceeae",
      brightYellow: "#ffce7a",
      brightBlue: "#8fb5ff",
      brightMagenta: "#dcb5ff",
      brightCyan: "#8ae8f8",
      brightWhite: "#f2f7fc",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    preview: ["#282a36", "#bd93f9", "#50fa7b", "#ff79c6"],
    colors: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "catppuccin",
    label: "Catppuccin Mocha",
    preview: ["#1e1e2e", "#89b4fa", "#a6e3a1", "#f38ba8"],
    colors: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e",
      selectionBackground: "#585b70",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
  },
  {
    id: "nord",
    label: "Nord",
    preview: ["#2e3440", "#81a1c1", "#a3be8c", "#bf616a"],
    colors: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "#434c5e",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
  {
    id: "gruvbox",
    label: "Gruvbox Dark",
    preview: ["#282828", "#83a598", "#b8bb26", "#fb4934"],
    colors: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      cursorAccent: "#282828",
      selectionBackground: "#504945",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    preview: ["#1a1b26", "#7aa2f7", "#9ece6a", "#f7768e"],
    colors: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "#33467c",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },
  {
    id: "one-dark",
    label: "One Dark",
    preview: ["#282c34", "#61afef", "#98c379", "#e06c75"],
    colors: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      cursorAccent: "#282c34",
      selectionBackground: "#3e4451",
      black: "#282c34",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    preview: ["#002b36", "#268bd2", "#859900", "#dc322f"],
    colors: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      cursorAccent: "#002b36",
      selectionBackground: "#073642",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#657b83",
      brightYellow: "#839496",
      brightBlue: "#93a1a1",
      brightMagenta: "#6c71c4",
      brightCyan: "#a1b0b0",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    preview: ["#fdf6e3", "#268bd2", "#859900", "#dc322f"],
    colors: {
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#586e75",
      cursorAccent: "#fdf6e3",
      selectionBackground: "#eee8d5",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#657b83",
      brightYellow: "#839496",
      brightBlue: "#93a1a1",
      brightMagenta: "#6c71c4",
      brightCyan: "#a1b0b0",
      brightWhite: "#fdf6e3",
    },
  },
];

export const DEFAULT_THEME_ID = "dshh";

export const TERMINAL_THEMES: Record<string, TerminalTheme> = Object.fromEntries(
  THEME_LIST.map((t) => [t.id, t])
);

/** Ordered for the picker; the house palette stays first. */
export const THEME_ORDER: TerminalTheme[] = THEME_LIST;

/** Look up a palette, falling back to the default for unknown ids. */
export function resolveTheme(id: string): TerminalTheme {
  return TERMINAL_THEMES[id] ?? TERMINAL_THEMES[DEFAULT_THEME_ID];
}
