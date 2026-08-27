/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Space Grotesk"', "system-ui", "sans-serif"],
        sans: ['"Inter"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      colors: {
        // "signal room", dark glass theme
        canvas: "#09090b",
        surface: "rgba(255, 255, 255, 0.07)",
        hairline: "rgba(255, 255, 255, 0.15)",
        ink: "#f8fafc",
        muted: "#94a3b8",
        brand: "#818cf8", // vibrant indigo
        "brand-soft": "rgba(129, 140, 248, 0.15)",
        down: "#ef4444", // KPI fell (bad)
        up: "#10b981", // KPI rose (good)
        warn: "#f59e0b", // uncertainty / ambiguous
        "warn-soft": "rgba(245, 158, 11, 0.15)",
      },
      boxShadow: {
        panel: "0 8px 32px 0 rgba(0, 0, 0, 0.37)",
      },
    },
  },
  plugins: [],
};
