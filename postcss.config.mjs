// Tailwind v4 PostCSS pipeline. The @tailwindcss/postcss plugin reads
// directives in globals.css (`@import "tailwindcss";`) and emits the
// generated stylesheet. No tailwind.config.* file needed in v4 — config
// lives inline in CSS via @theme / @layer directives.
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
