/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "#0a0e14",
          panel: "#0d121a",
          elev: "#131a24",
          hover: "#1a2330",
          inset: "#070a0f",
        },
        edge: {
          DEFAULT: "#1c2531",
          bright: "#2a3646",
        },
        ink: {
          hi: "#e3eaf3",
          mid: "#93a1b3",
          dim: "#5a6878",
        },
        accent: {
          DEFAULT: "#5b8cff",
          hover: "#7ca4ff",
          muted: "#33415e",
        },
        ok: "#3ecf8e",
        warn: "#e8a54c",
        err: "#f26d78",
        proto: {
          ssh: "#5b8cff",
          sftp: "#3ecf8e",
          ftp: "#e8a54c",
          serial: "#b78af7",
        },
      },
      fontFamily: {
        sans: ['"Geist Variable"', "system-ui", '"Segoe UI"', "sans-serif"],
        mono: ['"JetBrains Mono Variable"', '"Cascadia Code"', "Consolas", "monospace"],
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "modal-in": {
          from: { opacity: "0", transform: "scale(0.97) translateY(6px)" },
          to: { opacity: "1", transform: "scale(1) translateY(0)" },
        },
        "overlay-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        blink: {
          "0%, 54%": { opacity: "1" },
          "55%, 100%": { opacity: "0" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.25s cubic-bezier(0.16, 1, 0.3, 1) both",
        "modal-in": "modal-in 0.22s cubic-bezier(0.16, 1, 0.3, 1) both",
        "overlay-in": "overlay-in 0.18s ease-out both",
        blink: "blink 1.1s step-end infinite",
      },
    },
  },
  plugins: [],
};
