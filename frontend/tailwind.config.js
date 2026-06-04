/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: '#0f1923',
        secondary: '#1a2733',
        card: '#1e2d3d',
        border: '#2a3f52',
        accent: '#1da1f2',
        'text-primary': '#e1e8ed',
        'text-secondary': '#8899a6',
        green: '#00c853',
        red: '#ff1744',
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['SF Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
