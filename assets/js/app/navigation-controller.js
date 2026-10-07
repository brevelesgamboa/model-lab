const VIEW_ALIASES = {
  studio: "experiments",
  datasets: "experiments",
  method: "about",
};
const VIEWS = new Set(["lab", "experiments", "archive", "about"]);

export function resolveView(view) {
  const resolved = VIEW_ALIASES[view] || view;
  return VIEWS.has(resolved) ? resolved : "lab";
}

export function createNavigationController({
  elements,
  onNavigate,
  location = window.location,
  history = window.history,
}) {
  function navigate(view, updateHash = true) {
    const next = resolveView(view);
    elements.views.forEach((panel) => {
      const selected = panel.dataset.viewPanel === next;
      panel.hidden = !selected;
      panel.classList.toggle("is-active", selected);
    });
    elements.navItems.forEach((button) => {
      const selected = button.dataset.view === next;
      button.classList.toggle("is-active", selected);
      if (selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (updateHash && location.hash !== `#${next}`)
      history.replaceState(null, "", `#${next}`);
    onNavigate(next);
    return next;
  }
  return { navigate };
}
