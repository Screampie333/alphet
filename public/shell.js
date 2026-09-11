// shell.js
// The bits every Alphet page shares: the mobile drawer, the copy-address
// button, and the scrollspy that lights up whichever nav item matches the
// section you're looking at.
//
// Loaded before each page's own script, which then calls these. Plain script,
// not a module, so the pages still work when opened straight off disk.

window.AlphetShell = (function () {
  // Paste the real contract address here once it exists. One place, every page.
  const CONTRACT_ADDRESS = "";

  function initDrawer() {
    const sidebar = document.getElementById("sidebar");
    const backdrop = document.getElementById("backdrop");
    const menuOpen = document.getElementById("menuOpen");
    const menuClose = document.getElementById("menuClose");
    if (!sidebar || !backdrop || !menuOpen || !menuClose) return;

    function setDrawer(open) {
      sidebar.classList.toggle("open", open);
      backdrop.classList.toggle("open", open);
      menuOpen.setAttribute("aria-expanded", String(open));
      menuClose.style.display = open ? "inline-flex" : "none";
    }

    menuOpen.addEventListener("click", () => setDrawer(true));
    menuClose.addEventListener("click", () => setDrawer(false));
    backdrop.addEventListener("click", () => setDrawer(false));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setDrawer(false);
    });

    // Tapping any sidebar link on mobile should close the drawer behind you.
    document.querySelectorAll(".sidebar a, .sidebar .nav-item").forEach((item) => {
      item.addEventListener("click", () => setDrawer(false));
    });
  }

  function initContractCopy() {
    const btn = document.getElementById("caBtn");
    const value = document.getElementById("caValue");
    if (!btn || !value) return;

    if (CONTRACT_ADDRESS) {
      value.textContent =
        CONTRACT_ADDRESS.slice(0, 4) + "…" + CONTRACT_ADDRESS.slice(-4);
    }

    function flash(message) {
      const original = value.textContent;
      value.textContent = message;
      value.classList.add("copied");
      setTimeout(() => {
        value.textContent = original;
        value.classList.remove("copied");
      }, 1400);
    }

    btn.addEventListener("click", async () => {
      if (!CONTRACT_ADDRESS) {
        flash("Not live yet");
        return;
      }
      try {
        if (navigator.clipboard) {
          await navigator.clipboard.writeText(CONTRACT_ADDRESS);
        } else {
          // http:// origins and older browsers have no async clipboard.
          const tmp = document.createElement("textarea");
          tmp.value = CONTRACT_ADDRESS;
          document.body.appendChild(tmp);
          tmp.select();
          document.execCommand("copy");
          tmp.remove();
        }
        flash("Copied!");
      } catch {
        flash("Copy failed");
      }
    });
  }

  // Light up whichever nav item points at the section currently in view.
  // `selector` picks the item set, so the dashboard can drive its sidebar and
  // the docs page its table of contents with the same code.
  /**
   * In-page navigation without leaving "#gauge" sitting in the address bar.
   *
   * The sidebar links are ordinary anchors, so the browser writes their target
   * into the URL on click. That is right for a document and wrong for this:
   * every section is on the one page, so the hash names where you happen to be
   * scrolled rather than where you are, and it stays there afterwards.
   *
   * A hash that ARRIVES in the URL is still honoured - the browser has already
   * jumped by the time this runs, and a link someone was sent should land
   * where it says. Only hashes this page would write itself are suppressed.
   */
  function initCleanLinks(selector) {
    document.querySelectorAll(selector).forEach((link) => {
      link.addEventListener("click", (event) => {
        const id = (link.getAttribute("href") || "").slice(1);
        const target = id && document.getElementById(id);
        if (!target) return;

        // Modified clicks are the user asking for a new tab or a download.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

        event.preventDefault();

        // html { scroll-behavior: smooth } already applies, and honouring
        // prefers-reduced-motion is its job rather than this one's.
        target.scrollIntoView();

        // replaceState rather than pushState: these are not separate pages, so
        // adding history entries would make Back walk up the sidebar instead
        // of leaving the site.
        history.replaceState(null, "", location.pathname + location.search);
      });
    });
  }

  function initScrollSpy(selector) {
    const items = [...document.querySelectorAll(selector)];
    const sections = items
      .map((item) => document.getElementById(item.dataset.target))
      .filter(Boolean);
    if (!sections.length) return;

    const spy = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          items.forEach((item) => {
            item.classList.toggle("active", item.dataset.target === entry.target.id);
          });
        }
      },
      { rootMargin: "-45% 0px -50% 0px" }
    );

    sections.forEach((section) => spy.observe(section));
  }

  return { CONTRACT_ADDRESS, initDrawer, initContractCopy, initScrollSpy, initCleanLinks };
})();
