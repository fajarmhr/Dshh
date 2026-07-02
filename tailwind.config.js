/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "#0b0d10",
          panel: "#12151a",
          elev: "#181c23",
          hover: "#1e232b",
        },
        edge: "#232a33",
        accent: {
          DEFAULT: "#5b8cff",
          soft: "#2a3550",
        },
        proto: {
          ssh: "#5b8cff",
          sftp: "#37c6a4",
          ftp: "#f0a54a",
          serial: "#c07cff",
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Cascadia Code", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
