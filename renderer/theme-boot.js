// Runs in <head>, before the stylesheet paints, so the window never flashes the
// wrong theme. The saved theme comes from the main process through the preload.
// Light is the shipped default, the same as stevendesignco.com.
document.documentElement.dataset.theme = (window.cc && window.cc.initialTheme) === "dark" ? "dark" : "light";
