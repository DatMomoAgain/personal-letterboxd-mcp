// The page's own script, inlined with a per-request CSP nonce. It only rearranges what the
// server already rendered (and escaped): no data is fetched and no HTML is built from strings.
// Without it the page still works as one long document.

export const PAGE_SCRIPT = String.raw`(() => {
const d = document;
const $ = (s, c) => (c || d).querySelector(s);
const $$ = (s, c) => [...(c || d).querySelectorAll(s)];
d.documentElement.classList.add("js");

// ---- views -------------------------------------------------------------
const views = $$(".view");
const tabs = $$(".tabs a");
// On a phone the Taste topics start collapsed, except the first.
if (matchMedia("(max-width:760px)").matches) $$("details.topic").forEach((t, i) => { if (i) t.open = false; });
// A hash is either a view ("#films") or something inside one ("#t-loves" on Taste).
function show(id) {
  const target = id && d.getElementById(id);
  const fold = target && target.closest("details");
  if (fold) fold.open = true;
  const view = target && target.closest(".view");
  id = view ? view.id : "watch";
  views.forEach((v) => v.classList.toggle("on", v.id === id));
  tabs.forEach((a) => {
    if (a.getAttribute("href") === "#" + id) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (target && target !== view) target.scrollIntoView();
  else window.scrollTo(0, 0);
}
addEventListener("hashchange", () => show(location.hash.slice(1)));
show(location.hash.slice(1));

// ---- dialogs -----------------------------------------------------------
$$("[data-open]").forEach((b) =>
  b.addEventListener("click", () => {
    const dlg = d.getElementById(b.dataset.open);
    if (dlg && dlg.showModal) dlg.showModal();
  }),
);
$$("dialog").forEach((dlg) =>
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg || e.target.closest("[data-close]")) dlg.close();
  }),
);

// ---- watch next: one pick on stage at a time ---------------------------
const picks = $$(".pick");
const thumbs = $$(".thumb");
const glow = $(".glow");
function pick(i) {
  picks.forEach((p, j) => p.classList.toggle("on", j === i));
  thumbs.forEach((t, j) => t.setAttribute("aria-pressed", String(j === i)));
  const bg = picks[i] && picks[i].dataset.bg;
  if (glow) {
    glow.hidden = !bg;
    if (bg) glow.src = bg;
  }
}
const stage = $(".stage");
const bar = $(".top");
const motion = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
thumbs.forEach((t, i) => {
  t.addEventListener("click", () => {
    stage.classList.add("live"); // animate changes the viewer makes, not the first paint
    pick(i);
    // The card changes above the strip: bring it back if it's scrolled away (likely on a phone with the rows open).
    if (bar && stage.getBoundingClientRect().top < bar.getBoundingClientRect().bottom) {
      stage.scrollIntoView({ block: "start", behavior: motion() });
    }
  });
  t.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const n = (i + step + thumbs.length) % thumbs.length;
    thumbs[n].focus();
    thumbs[n].scrollIntoView({ block: "nearest", inline: "nearest" });
    pick(n);
  });
});
if (picks.length) pick(0);

// "See all" opens the strip into rows (with titles) and closes it again.
// It only shows when the picks don't fit across the strip.
const nav = $(".picks-nav");
const more = $(".see-all");
if (nav && more) {
  const strip = $(".strip", nav);
  const label = $("span", more);
  const count = $("b", more);
  const fits = () => {
    if (nav.classList.contains("open")) return;
    more.hidden = true;
    more.hidden = strip.scrollWidth <= strip.clientWidth;
  };
  more.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    more.setAttribute("aria-expanded", String(open));
    label.textContent = open ? "Show" : "See all";
    count.textContent = open ? "less" : more.dataset.n;
    if (!open) {
      fits();
      const on = $(".thumb[aria-pressed=true]", nav);
      if (on) on.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  });
  // Also covers the strip first becoming visible when the page opened on another view.
  new ResizeObserver(fits).observe(nav);
}

// ---- films: search, filter, sort, open one -----------------------------
const wall = $(".wall");
if (wall) {
  const STEP = 36;
  const items = $$("li", wall).map((li, i) => {
    const a = $("a", li);
    return {
      li, a, i,
      t: a.dataset.t || "",
      r: a.dataset.r ? Number(a.dataset.r) : null,
      y: Number(a.dataset.y) || 0,
      liked: a.dataset.l === "1",
      reviewed: a.dataset.v === "1",
    };
  });
  const q = $("#q"), rating = $("#rating"), decade = $("#decade"), sort = $("#sort");
  const flags = $$(".seg button");
  const count = $(".count"), more = $(".more"), none = $(".nomatch"), clear = $(".clear");
  const state = { q: "", flag: "", rating: "", decade: "", sort: "recent", shown: STEP };
  let visible = [];
  const fold = (s) => s.toLowerCase().normalize("NFD").replace(/[^\p{L}\p{N}]/gu, "");
  const sorters = {
    recent: (a, b) => a.i - b.i,
    high: (a, b) => (b.r ?? -1) - (a.r ?? -1) || a.i - b.i,
    low: (a, b) => (a.r ?? 9) - (b.r ?? 9) || a.i - b.i,
    new: (a, b) => b.y - a.y || a.i - b.i,
    old: (a, b) => (a.y || 9999) - (b.y || 9999) || a.i - b.i,
  };

  function apply() {
    const needle = fold(state.q);
    const list = items
      .filter(
        (x) =>
          (!needle || x.t.includes(needle)) &&
          (state.flag !== "liked" || x.liked) &&
          (state.flag !== "reviewed" || x.reviewed) &&
          (!state.rating || x.r === Number(state.rating)) &&
          (!state.decade || Math.floor(x.y / 10) * 10 === Number(state.decade)),
      )
      .sort(sorters[state.sort] || sorters.recent);
    visible = list.slice(0, state.shown);
    items.forEach((x) => (x.li.hidden = true));
    list.forEach((x) => wall.appendChild(x.li));
    visible.forEach((x) => (x.li.hidden = false));
    const filtered = needle || state.flag || state.rating || state.decade;
    count.textContent = filtered
      ? list.length + " of " + items.length + " films"
      : items.length + (items.length === 1 ? " film" : " films");
    clear.hidden = !filtered;
    none.hidden = list.length > 0;
    const left = list.length - visible.length;
    more.hidden = left <= 0;
    more.textContent = "Show " + Math.min(left, STEP) + " more";
  }
  const set = (patch) => {
    Object.assign(state, patch, { shown: STEP });
    q.value = state.q;
    rating.value = state.rating;
    decade.value = state.decade;
    sort.value = state.sort;
    flags.forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.flag || "") === state.flag)));
    apply();
  };

  q.addEventListener("input", () => set({ q: q.value }));
  rating.addEventListener("change", () => set({ rating: rating.value }));
  decade.addEventListener("change", () => set({ decade: decade.value }));
  sort.addEventListener("change", () => set({ sort: sort.value }));
  flags.forEach((b) => b.addEventListener("click", () => set({ flag: b.dataset.flag || "" })));
  clear.addEventListener("click", () => set({ q: "", flag: "", rating: "", decade: "" }));
  more.addEventListener("click", () => {
    state.shown += STEP;
    apply();
  });
  // The rating and decade charts on the Taste view jump here, filtered.
  $$("[data-jump-rating],[data-jump-decade]").forEach((b) =>
    b.addEventListener("click", () => {
      set({ q: "", flag: "", rating: b.dataset.jumpRating || "", decade: b.dataset.jumpDecade || "" });
      location.hash = "films";
    }),
  );

  const dlg = $("#film"), body = $("#film .film-body");
  let open = -1;
  function openFilm(n) {
    const x = visible[n];
    const tpl = x && $("template", x.li);
    if (!tpl) return;
    open = n;
    body.replaceChildren(tpl.content.cloneNode(true));
    if (!dlg.open) dlg.showModal();
  }
  wall.addEventListener("click", (e) => {
    const a = e.target.closest("a.film");
    if (!a || !dlg.showModal || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    openFilm(visible.findIndex((x) => x.a === a));
  });
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" && open < visible.length - 1) openFilm(open + 1);
    if (e.key === "ArrowLeft" && open > 0) openFilm(open - 1);
  });
  set({});
}

// ---- upload: show the chosen file's name -------------------------------
const file = $(".file input"), fileName = $(".file span");
if (file) file.addEventListener("change", () => {
  if (file.files && file.files[0]) fileName.textContent = file.files[0].name;
});
})();`;
