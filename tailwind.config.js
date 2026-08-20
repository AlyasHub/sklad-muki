export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Основной шрифт всего приложения — Open Sans; заголовки/крупные цифры — Poppins (класс font-display)
        sans: ["'Open Sans'", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        display: ["Poppins", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        // «Тёплая глина» — акцент бренда. Раньше accent был amber; переопределяем всю шкалу amber → глина,
        // чтобы перекрасить всё приложение разом, не трогая тысячи классов.
        amber: {
          50: "#FBF3EF", 100: "#F6E0D5", 200: "#EEC3AE", 300: "#E29E7C", 400: "#D2734A",
          500: "#C2410C", 600: "#A5370A", 700: "#872D08", 800: "#6B2408", 900: "#481806",
        },
        // Тёплый нейтрал вместо холодного серого (те же уровни яркости, что у gray, только теплее — как stone)
        gray: {
          50: "#FAFAF9", 100: "#F5F4F2", 200: "#E7E5E2", 300: "#D6D3CE", 400: "#A8A29B",
          500: "#78716A", 600: "#57534D", 700: "#44403B", 800: "#292521", 900: "#1C1917",
        },
      },
    },
  },
  plugins: [],
};
