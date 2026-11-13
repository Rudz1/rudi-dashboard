/* Rudi Research — client-only, encrypted at rest. */
(function () {
  "use strict";

  const TYPES = {
    Person: { label: "Person", color: "#ff8fa3", prefix: "P" },
    Pet: { label: "Pet", color: "#ffa94d", prefix: "PET" },
    Place: { label: "Place / Address", color: "#6cc7ff", prefix: "PL" },
    Interest: { label: "Interest / Likes", color: "#5eead4", prefix: "I" },
    Event: { label: "Event / Date", color: "#f5c451", prefix: "E" },
    Conversation: { label: "Conversation", color: "#b9a4ff", prefix: "C" },
    Topic: { label: "Topic to raise", color: "#ff9d80", prefix: "T" },
    Fact: { label: "Fact / Note", color: "#7be0b0", prefix: "F" },
    Organisation: { label: "Organisation", color: "#f08cf0", prefix: "O" },
  };
  const TYPE_ORDER = Object.keys(TYPES);
  const LINK_SUGGESTIONS = [
    "mum of", "dad of", "sister of", "brother of", "sibling of", "partner of",
    "friend of", "family of", "lives at", "owns", "loves", "likes",
    "looks after", "works at", "attending", "mentioned", "topic for", "fact about",
  ];
  const LS_KEY = "people-map-blob";
  const IDLE_MS = 30 * 60 * 1000;
  const TZ = "Europe/London";

  let publishedBlob = null;
  let passphrase = null;
  let graph = null;
  let cy = null;
  let currentView = "graph";
  let selectedId = null;
  let typeFilter = new Set(TYPE_ORDER);
  let dirty = false;
  let usingLocalDraft = false;
  let idleTimer = null;
  let searchTerm = "";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

  function typeInfo(t) {
    return TYPES[t] || { label: t || "Unknown", color: "#b5c7d3", prefix: "X" };
  }
  function entityById(id) {
    return (graph.entities || []).find((e) => e.id === id) || null;
  }
  function displayName(e) {
    if (!e) return "";
    return e.display || e.value || e.id;
  }
  function shortLabel(s) {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > 20 ? t.slice(0, 19) + "\u2026" : t;
  }
  function pairKey(a, b) {
    return a < b ? a + "\0" + b : b + "\0" + a;
  }
  /** One link per unordered pair; prefer the outgoing link from `fromId` if given. */
  function uniquePairLinks(links, fromId) {
    const best = new Map();
    (links || []).forEach((l) => {
      if (!l || !l.from || !l.to || l.from === l.to) return;
      const key = pairKey(l.from, l.to);
      const prev = best.get(key);
      if (!prev) { best.set(key, l); return; }
      const curS = linkStatus(l), prevS = linkStatus(prev);
      if (curS === "confirmed" && prevS === "research") { best.set(key, l); return; }
      if (curS === "research" && prevS === "confirmed") return;
      if (fromId && l.from === fromId && prev.from !== fromId) best.set(key, l);
    });
    return [...best.values()];
  }
  function linkDateForDisplay(link, a, b) {
    const d = String((link && link.date) || "").trim();
    if (!d) return "";
    const norm = (s) => String(s || "").trim();
    const bdays = [a, b].map((e) => e && e.properties && e.properties.birthday).filter(Boolean).map(norm);
    if (bdays.some((bd) => bd === d || (bd.length === 5 && d.endsWith("-" + bd)) || (d.length === 5 && bd.endsWith("-" + d)))) return "";
    return d;
  }
  function linkStatus(l) {
    const s = String((l && l.status) || "confirmed").trim().toLowerCase();
    if (s === "research" || s === "possible" || s === "unconfirmed" || s === "maybe") return "research";
    return "confirmed";
  }
  function bumpIdle() {
    if (!graph) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => lock("Locked after 30 minutes without use."), IDLE_MS);
  }
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("on");
    setTimeout(() => el.classList.remove("on"), 2800);
  }
  function londonNow() {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    return new Date(+get("year"), +get("month") - 1, +get("day"), +get("hour"), +get("minute"));
  }
  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function fmtDate(s) {
    const d = s instanceof Date ? s : parseDate(s);
    if (!d) return s || "";
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() !== londonNow().getFullYear() ? "numeric" : undefined });
  }
  function parseDate(s, yearHint) {
    if (!s) return null;
    const str = String(s).trim();
    let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = str.match(/^(\d{2})-(\d{2})$/);
    if (m) return new Date(yearHint || londonNow().getFullYear(), +m[1] - 1, +m[2]);
    return null;
  }
  function nextOccurrence(s, recurring) {
    const today = new Date(londonNow().getFullYear(), londonNow().getMonth(), londonNow().getDate());
    const annual = /annual|yearly|birthday|recurring/i.test(String(recurring || "")) || /^\d{2}-\d{2}$/.test(String(s || "").trim());
    if (annual) {
      const thisYear = parseDate(String(s).replace(/^\d{4}-/, ""), today.getFullYear()) || parseDate(s, today.getFullYear());
      if (!thisYear) return null;
      const d = new Date(thisYear);
      d.setFullYear(today.getFullYear());
      if (d < today) d.setFullYear(today.getFullYear() + 1);
      return d;
    }
    return parseDate(s);
  }
  function inNextDays(d, n) {
    if (!d) return false;
    const today = new Date(londonNow().getFullYear(), londonNow().getMonth(), londonNow().getDate());
    const end = new Date(today);
    end.setDate(end.getDate() + n);
    return d >= today && d <= end;
  }

  function normalizeType(t) {
    const map = {
      "place/address": "Place", place: "Place", address: "Place",
      "interest/likes": "Interest", interest: "Interest", like: "Interest", likes: "Interest",
      "event/date": "Event", event: "Event", date: "Event",
      "topic-to-raise": "Topic", topic: "Topic",
      "fact/note": "Fact", fact: "Fact", note: "Fact",
      organization: "Organisation", organisation: "Organisation",
      pet: "Pet", person: "Person", conversation: "Conversation",
    };
    const key = String(t || "").trim().toLowerCase();
    return map[key] || t || "Fact";
  }

  function nextId(type) {
    const prefix = typeInfo(type).prefix;
    const ids = new Set((graph.entities || []).map((e) => e.id).concat((graph.links || []).map((l) => l.id)));
    let n = 1;
    while (ids.has(`${prefix}-${String(n).padStart(4, "0")}`)) n += 1;
    return `${prefix}-${String(n).padStart(4, "0")}`;
  }

  /* ---------- lock / unlock ---------- */
  function showGate(msg) {
    $("err").textContent = msg || "";
    $("app").classList.remove("show");
    $("app").style.display = "none";
    $("app").style.visibility = "hidden";
    $("gate").style.display = "flex";
    $("pw").value = "";
    $("pw").focus();
  }
  function showApp() {
    $("gate").style.display = "none";
    $("app").style.display = "flex";
    $("app").style.visibility = "visible";
    $("app").classList.add("show");
    $("pw").value = "";
    $("err").textContent = "";
  }
  function lock(msg) {
    graph = null;
    passphrase = null;
    selectedId = null;
    dirty = false;
    usingLocalDraft = false;
    if (cy) {
      cy.destroy();
      cy = null;
    }
    $("panel").innerHTML = "<h2>Details</h2><p class=\"empty\">Click a person, pet, place or like on the graph to see how they connect.</p>";
    $("person-profile").innerHTML = "";
    $("upcoming-list").innerHTML = "";
    currentView = "graph";
    document.querySelectorAll(".nav [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === "graph"));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.dataset.view === "graph"));
    $("workspace").classList.remove("no-panel");
    $("panel").style.display = "";
    clearTimeout(idleTimer);
    showGate(msg || "Locked.");
  }

  async function tryDecrypt(blob, pw) {
    return PeopleCrypto.decrypt(blob, pw);
  }

  async function unlock(pw) {
    const btn = $("unlock-btn");
    const err = $("err");
    btn.disabled = true;
    err.textContent = "Checking…";
    try {
      if (!publishedBlob) {
        const res = await fetch("data.enc.json", { cache: "no-store" });
        if (!res.ok) throw new Error("Could not load the encrypted data file.");
        publishedBlob = await res.json();
      }
      let used = null;
      let localOk = false;
      const localRaw = localStorage.getItem(LS_KEY);
      if (localRaw) {
        try {
          const localBlob = JSON.parse(localRaw);
          used = await tryDecrypt(localBlob, pw);
          localOk = true;
        } catch (e) {
          localOk = false;
        }
      }
      let published;
      try {
        published = await tryDecrypt(publishedBlob, pw);
      } catch (e) {
        if (!localOk) {
          if (e && e.name === "OperationError") throw new Error("Wrong passphrase — try again.");
          throw e;
        }
      }
      if (localOk && published) {
        const lu = Date.parse(used.updated || 0) || 0;
        const pu = Date.parse(published.updated || 0) || 0;
        if (lu > pu) {
          graph = used;
          usingLocalDraft = true;
        } else {
          graph = published;
          usingLocalDraft = false;
        }
      } else if (localOk) {
        graph = used;
        usingLocalDraft = true;
      } else {
        graph = published;
        usingLocalDraft = false;
      }
      graph.entities.forEach((e) => { e.type = normalizeType(e.type); });
      passphrase = pw;
      currentView = "graph";
      showApp();
      $("local-banner").hidden = !usingLocalDraft;
      const isExample = /EXAMPLE/i.test(graph.title || "") || /EXAMPLE/i.test(graph.disclaimer || "");
      $("example-banner").style.display = isExample ? "block" : "none";
      renderAll();
      setView("graph");
      bumpIdle();
    } catch (e) {
      err.textContent = (e && e.name === "OperationError")
        ? "Wrong passphrase — try again."
        : (e.message || "Could not unlock.");
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- graph view ---------- */
  function graphElements() {
    const visible = new Set(
      (graph.entities || [])
        .filter((e) => typeFilter.has(e.type) && matchesSearch(e))
        .map((e) => e.id)
    );
    const nodes = (graph.entities || [])
      .filter((e) => visible.has(e.id))
      .map((e) => {
        const full = displayName(e);
        return {
          data: {
            id: e.id,
            short: shortLabel(full),
            full,
            type: e.type,
            color: typeInfo(e.type).color,
          },
        };
      });
    const edges = uniquePairLinks((graph.links || []).filter((l) => visible.has(l.from) && visible.has(l.to)))
      .map((l) => ({
        data: {
          id: l.id,
          source: l.from,
          target: l.to,
          label: l.label || "",
          status: linkStatus(l),
          confidence: l.confidence || "",
          source_url: l.source_url || "",
        },
      }));
    return { nodes, edges };
  }
  function matchesSearch(e) {
    if (!searchTerm) return true;
    const q = searchTerm.toLowerCase();
    const blob = [e.id, e.type, displayName(e), e.notes, e.sources, JSON.stringify(e.properties || {})].join(" ").toLowerCase();
    if (blob.includes(q)) return true;
    return (graph.links || []).some((l) => {
      if (l.from !== e.id && l.to !== e.id) return false;
      const other = entityById(l.from === e.id ? l.to : l.from);
      return (l.label || "").toLowerCase().includes(q) || (other && displayName(other).toLowerCase().includes(q));
    });
  }

  function ensureCy() {
    if (cy) return;
    cy = cytoscape({
      container: $("cy"),
      elements: graphElements(),
      minZoom: 0.2,
      maxZoom: 3,
      wheelSensitivity: 0.3,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            label: "data(short)",
            color: "#d5ecea",
            "font-size": 10,
            "font-weight": 500,
            "font-family": "system-ui,-apple-system,Segoe UI,sans-serif",
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 8,
            "text-wrap": "ellipsis",
            "text-max-width": 86,
            "text-background-color": "#042f33",
            "text-background-opacity": 0.86,
            "text-background-padding": 2,
            "text-background-shape": "roundrectangle",
            "text-events": "yes",
            width: 12,
            height: 12,
            "border-width": 1,
            "border-color": "rgba(244,251,250,.4)",
            "text-outline-color": "#042f33",
            "text-outline-width": 2,
            "overlay-opacity": 0,
            "z-index": 10,
          },
        },
        {
          selector: "node[type = 'Person']",
          style: { width: 14, height: 14 },
        },
        {
          selector: "node[type = 'Event'], node[type = 'Conversation'], node[type = 'Topic'], node[type = 'Fact']",
          style: { "text-opacity": 0, width: 10, height: 10 },
        },
        {
          selector: "node.hover, node.selected",
          style: {
            label: "data(full)",
            "text-wrap": "none",
            "text-max-width": 220,
            "text-opacity": 1,
            "font-weight": 600,
            "z-index": 30,
          },
        },
        {
          selector: "node.selected",
          style: {
            width: 16,
            height: 16,
            "border-width": 2,
            "border-color": "#f5c451",
          },
        },
        {
          selector: "edge",
          style: {
            width: 0.7,
            "line-color": "rgba(169,211,208,.22)",
            "target-arrow-shape": "none",
            "curve-style": "straight",
            label: "data(label)",
            "font-size": 8,
            "font-weight": 500,
            color: "#a9d3d0",
            "text-rotation": "autorotate",
            "text-opacity": 0,
            "text-outline-color": "#042f33",
            "text-outline-width": 2,
            "overlay-opacity": 0,
          },
        },
        {
          selector: "edge.emphasized, edge.show-label",
          style: {
            width: 1.2,
            "line-color": "rgba(169,211,208,.58)",
          },
        },
        {
          selector: "edge.show-label",
          style: {
            "text-opacity": 0.92,
            "font-size": 9,
          },
        },
        {
          selector: "edge[status = 'research']",
          style: {
            "line-style": "dashed",
            "line-dash-pattern": [6, 4],
            width: 0.9,
            "line-color": "rgba(245,196,81,.5)",
            label: "?",
            "text-opacity": 1,
            "font-size": 10,
            "font-weight": 700,
            color: "#f5c451",
            "text-background-color": "#042f33",
            "text-background-opacity": 0.92,
            "text-background-padding": 2,
            "text-background-shape": "roundrectangle",
            "text-rotation": "none",
          },
        },
        {
          selector: "edge[status = 'research'].emphasized, edge[status = 'research'].show-label",
          style: {
            width: 1.2,
            "line-color": "rgba(245,196,81,.8)",
          },
        },
        {
          selector: "edge[status = 'research'].show-label",
          style: {
            label: "data(label)",
            "font-size": 9,
            "font-weight": 500,
            "text-opacity": 0.95,
            "text-rotation": "autorotate",
          },
        },
        {
          selector: "node.dim",
          style: { opacity: 0.16, "text-opacity": 0 },
        },
        {
          selector: "edge.dim",
          style: { opacity: 0.07, "text-opacity": 0 },
        },
      ],
      layout: layoutOpts("cose"),
    });
    cy.on("tap", "node", (ev) => {
      selectEntity(ev.target.id());
    });
    cy.on("tap", (ev) => {
      if (ev.target === cy) selectEntity(null);
    });
    cy.on("mouseover", "node", (ev) => {
      ev.target.addClass("hover");
      ev.target.connectedEdges().addClass("emphasized");
    });
    cy.on("mouseout", "node", (ev) => {
      ev.target.removeClass("hover");
      if (!ev.target.hasClass("selected")) ev.target.connectedEdges().removeClass("emphasized");
    });
    cy.on("mouseover", "edge", (ev) => ev.target.addClass("show-label"));
    cy.on("mouseout", "edge", (ev) => ev.target.removeClass("show-label"));
  }
  function layoutOpts(name) {
    const box = cy ? Math.min(cy.width(), cy.height()) : 800;
    const compact = box < 520;
    const pad = compact ? 36 : 68;
    if (name === "cose") {
      return {
        name: "cose",
        animate: false,
        fit: true,
        padding: pad,
        randomize: true,
        nodeDimensionsIncludeLabels: false,
        nodeRepulsion: function () { return compact ? 8000 : 18000; },
        nodeOverlap: 28,
        idealEdgeLength: function () { return compact ? 140 : 240; },
        edgeElasticity: function () { return 32; },
        gravity: 0.12,
        numIter: 2500,
        componentSpacing: 100,
        initialTemp: 1000,
        coolingFactor: 0.99,
        minTemp: 1,
      };
    }
    if (name === "circle") return { name: "circle", padding: pad, animate: false, fit: true, spacingFactor: compact ? 1.3 : 1.7, nodeDimensionsIncludeLabels: true };
    if (name === "breadthfirst") return { name: "breadthfirst", directed: true, padding: pad, spacingFactor: compact ? 1.4 : 1.9, animate: false, fit: true, nodeDimensionsIncludeLabels: true };
    // Default: concentric by degree — selected / highly connected people sit towards the centre, with room for labels.
    return {
      name: "concentric",
      animate: false,
      fit: true,
      padding: pad,
      equidistant: true,
      minNodeSpacing: compact ? 52 : 118,
      spacingFactor: compact ? 1.35 : 1.85,
      startAngle: Math.PI / 2,
      clockwise: true,
      concentric: function (node) { return node.degree(); },
      levelWidth: function (nodes) { return Math.max(1, Math.ceil(nodes.maxDegree() / 3)); },
    };
  }
  function applyGraphHighlights() {
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass("selected dim show-label hover emphasized");
      if (selectedId && cy.$id(selectedId).length) {
        const n = cy.$id(selectedId);
        n.addClass("selected");
        const neighbourhood = n.closedNeighborhood();
        n.connectedEdges().addClass("emphasized");
        cy.elements().difference(neighbourhood).addClass("dim");
        cy.edges().forEach((edge) => {
          const src = edge.data("source"), tgt = edge.data("target");
          const matches = (graph.links || []).filter((l) => pairKey(l.from, l.to) === pairKey(src, tgt));
          const preferred = matches.find((l) => l.from === selectedId) || matches[0];
          if (preferred) {
            edge.data("label", preferred.label || "");
            edge.data("status", linkStatus(preferred));
            edge.data("confidence", preferred.confidence || "");
            edge.data("source_url", preferred.source_url || "");
          }
        });
      }
    });
  }
  function layoutMap() {
    if (!cy || cy.nodes().empty()) return;
    const compact = Math.min(cy.width(), cy.height()) < 520;
    const centerSel = (selectedId && cy.$id(selectedId).length)
      ? cy.$id(selectedId)
      : cy.nodes().max((n) => (n.data("type") === "Person" ? n.degree() + 80 : n.degree())).ele;
    const rings = [
      { types: ["Person"], minSep: compact ? 76 : 118, step: compact ? 78 : 150 },
      { types: ["Pet", "Place", "Organisation", "Interest"], minSep: compact ? 62 : 96, step: compact ? 48 : 88 },
      { types: ["Event", "Conversation", "Topic", "Fact"], minSep: compact ? 26 : 40, step: compact ? 42 : 72 },
    ];
    cy.batch(() => {
      centerSel.position({ x: 0, y: 0 });
      let r = 0;
      rings.forEach((ring, idx) => {
        const arr = cy.nodes()
          .filter((n) => n.id() !== centerSel.id() && ring.types.includes(n.data("type")))
          .toArray()
          .sort((a, b) => String(a.data("full") || a.id()).localeCompare(String(b.data("full") || b.id())));
        if (!arr.length) return;
        const need = (ring.minSep * arr.length) / (2 * Math.PI);
        r = idx === 0 ? Math.max(ring.step, need) : Math.max(r + ring.step, need);
        const start = -Math.PI / 2 + idx * 0.18;
        arr.forEach((node, i) => {
          const a = start + (2 * Math.PI * i) / arr.length;
          node.position({ x: Math.cos(a) * r, y: Math.sin(a) * r });
        });
      });
    });
    const bb = cy.elements().boundingBox({ includeLabels: true });
    const zx = (cy.width() - (compact ? 28 : 40)) / Math.max(bb.w, 1);
    const zy = (cy.height() - (compact ? 28 : 40)) / Math.max(bb.h, 1);
    const z = Math.max(compact ? 0.78 : 0.92, Math.min(1, zx, zy));
    cy.zoom(z);
    cy.center();
  }
  function redrawGraph(layoutName) {
    ensureCy();
    cy.elements().remove();
    cy.add(graphElements());
    const name = layoutName || "concentric";
    if (name === "concentric") {
      layoutMap();
    } else {
      cy.layout(layoutOpts(name)).run();
      separateNameLabels();
      cy.fit(undefined, Math.min(cy.width(), cy.height()) < 520 ? 28 : 56);
      if (cy.zoom() < 0.85) { cy.zoom(0.85); cy.center(); }
    }
    applyGraphHighlights();
  }
  function separateNameLabels() {
    if (!cy) return;
    const keep = new Set(["Person", "Pet", "Place", "Interest", "Organisation"]);
    const nodes = cy.nodes().filter((n) => keep.has(n.data("type")));
    const labW = 90, labH = 14, gap = 8;
    for (let iter = 0; iter < 80; iter++) {
      let moved = false;
      const items = nodes.map((n) => {
        const p = n.position();
        return { n, x: p.x, y: p.y + 16 };
      });
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i], b = items[j];
          const ox = (labW + gap) - Math.abs(a.x - b.x);
          const oy = (labH + gap) - Math.abs(a.y - b.y);
          if (ox <= 0 || oy <= 0) continue;
          if (ox < oy) {
            const s = (a.x === b.x ? 1 : Math.sign(a.x - b.x)) * ox / 2;
            a.n.position("x", a.n.position("x") + s);
            b.n.position("x", b.n.position("x") - s);
            a.x += s; b.x -= s;
          } else {
            const s = (a.y === b.y ? 1 : Math.sign(a.y - b.y)) * oy / 2;
            a.n.position("y", a.n.position("y") + s);
            b.n.position("y", b.n.position("y") - s);
            a.y += s; b.y -= s;
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
  }
  function renderFilters() {
    const el = $("filters");
    el.innerHTML = TYPE_ORDER.map((t) => {
      const on = typeFilter.has(t) ? " on" : "";
      return `<button type="button" class="chip${on}" data-type="${esc(t)}" style="color:${typeInfo(t).color}"><i></i>${esc(typeInfo(t).label)}</button>`;
    }).join("") +
      `<span class="research-legend"><em>?</em> dashed = research (unconfirmed)</span>` +
      `<div class="layout-btns">
        <button type="button" class="textbtn" data-layout="concentric">Map</button>
        <button type="button" class="textbtn" data-layout="cose">Force</button>
        <button type="button" class="textbtn" data-layout="breadthfirst">Tree</button>
        <button type="button" class="textbtn" data-layout="circle">Circle</button>
      </div>`;
    el.querySelectorAll("[data-type]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = btn.dataset.type;
        if (typeFilter.has(t)) typeFilter.delete(t);
        else typeFilter.add(t);
        if (typeFilter.size === 0) TYPE_ORDER.forEach((x) => typeFilter.add(x));
        renderFilters();
        redrawGraph();
      });
    });
    el.querySelectorAll("[data-layout]").forEach((btn) => {
      btn.addEventListener("click", () => redrawGraph(btn.dataset.layout));
    });
  }

  /* ---------- detail / profile ---------- */
  function linksFor(id) {
    return (graph.links || []).filter((l) => l.from === id || l.to === id);
  }
  function neighbours(id, typeWanted) {
    const out = [];
    uniquePairLinks(linksFor(id), id).forEach((l) => {
      const otherId = l.from === id ? l.to : l.from;
      const e = entityById(otherId);
      if (!e) return;
      if (typeWanted && e.type !== typeWanted) return;
      out.push({ entity: e, link: l, direction: l.from === id ? "out" : "in" });
    });
    out.sort((a, b) => {
      const ar = linkStatus(a.link) === "research" ? 0 : 1;
      const br = linkStatus(b.link) === "research" ? 0 : 1;
      if (ar !== br) return ar - br;
      return displayName(a.entity).localeCompare(displayName(b.entity));
    });
    return out;
  }
  function entityDate(e) {
    return (e.properties && (e.properties.date || e.properties.birthday)) || "";
  }
  function timelineFor(personId) {
    const items = [];
    neighbours(personId).forEach(({ entity, link }) => {
      if (["Event", "Conversation", "Fact"].includes(entity.type) || link.label === "timeline") {
        const date = entityDate(entity) || link.date || "";
        items.push({
          date,
          title: displayName(entity),
          details: entity.notes || (entity.properties && entity.properties.summary) || "",
          id: entity.id,
          type: entity.type,
        });
      }
    });
    (graph.entities || []).forEach((e) => {
      if (e.id === personId && e.properties && e.properties.how_we_met) {
        items.push({ date: "", title: "How we met", details: e.properties.how_we_met, id: e.id, type: "Person" });
      }
    });
    items.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    return items;
  }
  function topicsFor(personId) {
    return neighbours(personId, "Topic").map(({ entity }) => entity)
      .concat((graph.entities || []).filter((e) => e.type === "Topic" && e.properties && e.properties.related_person_id === personId));
  }
  function uniqueEntities(arr) {
    const seen = new Set();
    return arr.filter((e) => {
      const id = e.id || (e.entity && e.entity.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  function factsFor(personId) {
    const fromLinks = neighbours(personId, "Fact").map(({ entity }) => entity);
    const fromProps = [];
    const e = entityById(personId);
    if (e && e.properties) {
      ["birthday", "likes", "dislikes", "important_names", "nickname", "relationship"].forEach((k) => {
        if (e.properties[k]) fromProps.push({ id: e.id + ":" + k, type: "Fact", value: e.properties[k], display: e.properties[k], properties: { category: k } });
      });
    }
    return { linked: uniqueEntities(fromLinks), props: fromProps };
  }

  function renderPanel(id) {
    const el = $("panel");
    if (!id) {
      el.innerHTML = "<h2>Details</h2><p class=\"empty\">Click a person, pet, place or like on the graph to see how they connect.</p>";
      return;
    }
    const e = entityById(id);
    if (!e) return;
    const ti = typeInfo(e.type);
    const props = e.properties || {};
    const kv = Object.keys(props).filter((k) => props[k] !== "" && props[k] != null)
      .map((k) => `<div class="kv"><div class="k">${esc(k.replace(/_/g, " "))}</div><div class="v">${esc(props[k])}</div></div>`)
      .join("");
    const conns = neighbours(id).map(({ entity, link }) => {
      const label = link.label || "related to";
      const when = linkDateForDisplay(link, e, entity);
      const research = linkStatus(link) === "research";
      const conf = String(link.confidence || "").toLowerCase();
      const confLabel = conf === "low" || conf === "med" || conf === "high" ? conf : "";
      const src = String(link.source_url || "").trim();
      const srcHtml = src ? ` · <a href="${esc(src)}" target="_blank" rel="noopener noreferrer">source</a>` : "";
      const line = `${research ? "Research" : esc(label)} · ${esc(typeInfo(entity.type).label)}${when ? " · " + esc(fmtDate(when)) : ""}`;
      const extra = research ? `
        <div class="research-meta">${confLabel ? "Confidence: " + esc(confLabel) : "Confidence not set"}${srcHtml}<div>${esc(label)}</div></div>
        <div class="research-actions">
          <button type="button" class="textbtn gold" data-confirm-link="${esc(link.id)}">Confirm</button>
          <button type="button" class="textbtn warn" data-reject-link="${esc(link.id)}">Reject</button>
        </div>` : "";
      return `<li class="${research ? "research-item" : ""}"><button type="button" data-open="${esc(entity.id)}"><strong>${esc(displayName(entity))}</strong><small style="display:block;color:var(--dim)">${line}</small></button>${extra}</li>`;
    }).join("");
    el.innerHTML = `
      <div class="type-pill" style="color:${ti.color}">${esc(ti.label)}</div>
      <div class="name">${esc(displayName(e))}</div>
      <div class="meta">${esc(e.id)}${e.sources ? " · " + esc(e.sources) : ""}${e.updated ? " · updated " + esc(e.updated) : ""}</div>
      ${e.notes ? `<p style="font-size:.9rem;margin-bottom:.6rem">${esc(e.notes)}</p>` : ""}
      ${kv}
      <div class="actions">
        <button type="button" class="textbtn gold" data-edit="${esc(e.id)}">Edit</button>
        <button type="button" class="textbtn gold" data-add-link="${esc(e.id)}">Add link</button>
        ${e.type === "Person" ? `<button type="button" class="textbtn" data-open-profile="${esc(e.id)}">Open profile</button>` : ""}
        <button type="button" class="textbtn warn" data-delete="${esc(e.id)}">Delete</button>
      </div>
      <div class="sec-label">Connections</div>
      <ul class="conn-list">${conns || "<li class='empty'>No links yet.</li>"}</ul>
    `;
    bindPanel(el);
  }
  function bindPanel(el) {
    el.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => selectEntity(b.dataset.open)));
    el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openEditor("entity", b.dataset.edit)));
    el.querySelectorAll("[data-add-link]").forEach((b) => b.addEventListener("click", () => openEditor("link", null, b.dataset.addLink)));
    el.querySelectorAll("[data-open-profile]").forEach((b) => b.addEventListener("click", () => {
      selectedId = b.dataset.openProfile;
      setView("person");
    }));
    el.querySelectorAll("[data-delete]").forEach((b) => b.addEventListener("click", () => deleteEntity(b.dataset.delete)));
    el.querySelectorAll("[data-confirm-link]").forEach((b) => b.addEventListener("click", (ev) => { ev.stopPropagation(); confirmLink(b.dataset.confirmLink); }));
    el.querySelectorAll("[data-reject-link]").forEach((b) => b.addEventListener("click", (ev) => { ev.stopPropagation(); rejectLink(b.dataset.rejectLink); }));
  }
  function confirmLink(id) {
    const l = (graph.links || []).find((x) => x.id === id);
    if (!l) return;
    l.status = "confirmed";
    markDirty();
    renderAll();
    if (selectedId) selectEntity(selectedId);
    toast("Marked as confirmed. Click Save to encrypt a new copy.");
  }
  function rejectLink(id) {
    const l = (graph.links || []).find((x) => x.id === id);
    if (!l) return;
    if (!confirm("Reject this research link and remove it?")) return;
    graph.links = graph.links.filter((x) => x.id !== id);
    markDirty();
    renderAll();
    if (selectedId) selectEntity(selectedId);
    toast("Research link removed. Click Save to encrypt a new copy.");
  }

  function renderPersonProfile(id) {
    const wrap = $("person-profile");
    const sel = $("person-select");
    const people = (graph.entities || []).filter((e) => e.type === "Person").sort((a, b) => displayName(a).localeCompare(displayName(b)));
    sel.innerHTML = people.map((p) => `<option value="${esc(p.id)}"${p.id === id ? " selected" : ""}>${esc(displayName(p))}</option>`).join("");
    const e = entityById(id) || people[0];
    if (!e) {
      wrap.innerHTML = "<p class='empty'>No people in this map yet. Click Add to create one.</p>";
      return;
    }
    selectedId = e.id;
    const facts = factsFor(e.id);
    const topics = uniqueEntities(topicsFor(e.id));
    const toRaise = topics.filter((t) => String((t.properties || {}).status || "to raise").toLowerCase() !== "raised");
    const raised = topics.filter((t) => String((t.properties || {}).status || "").toLowerCase() === "raised");
    const tl = timelineFor(e.id);
    const peopleLinks = neighbours(e.id, "Person");
    const pets = neighbours(e.id, "Pet");
    const places = neighbours(e.id, "Place");
    const likes = neighbours(e.id, "Interest");
    const orgs = neighbours(e.id, "Organisation");

    const factHtml = facts.props.map((f) => `<div class="kv"><div class="k">${esc(f.properties.category.replace(/_/g, " "))}</div><div class="v">${esc(f.display)}</div></div>`).join("") +
      facts.linked.map((f) => `<div class="kv"><div class="k">${esc((f.properties && f.properties.category) || "fact")}</div><div class="v">${esc(displayName(f))}</div></div>`).join("");

    const askHtml = (list) => list.map((t) => `
      <li>
        <button type="button" data-open="${esc(t.id)}">
          <strong>${esc(displayName(t))}</strong>
          <small style="display:block;color:var(--dim)">${esc((t.properties || {}).status || "to raise")}${t.notes ? " · " + esc(t.notes) : ""}</small>
        </button>
      </li>`).join("") || "<li class='empty'>Nothing listed yet.</li>";

    const chips = (arr) => arr.map(({ entity, link }) =>
      `<button type="button" class="person-chip${linkStatus(link) === "research" ? " research" : ""}" data-open="${esc(entity.id)}">${esc(displayName(entity))}<small style="display:block;color:var(--dim)">${linkStatus(link) === "research" ? "Research · " : ""}${esc(link.label || "")}</small></button>`
    ).join("") || "<span class='empty'>None listed.</span>";

    wrap.innerHTML = `
      <div class="grid-2">
        <div class="blk">
          <h3>Key facts</h3>
          <div class="name">${esc(displayName(e))}</div>
          <div class="meta">${esc(typeInfo(e.type).label)}${e.notes ? " · " + esc(e.notes) : ""}</div>
          ${factHtml || "<p class='empty'>No facts yet.</p>"}
          <div class="actions">
            <button type="button" class="textbtn gold" data-edit="${esc(e.id)}">Edit person</button>
            <button type="button" class="textbtn gold" data-add-link="${esc(e.id)}">Add link</button>
          </div>
        </div>
        <div class="blk pink">
          <h3>Conversations to have / things to ask next time</h3>
          <ul class="ask-list">${askHtml(toRaise)}</ul>
          ${raised.length ? `<div class="sec-label">Already raised</div><ul class="ask-list">${askHtml(raised)}</ul>` : ""}
        </div>
        <div class="blk mint">
          <h3>Timeline</h3>
          <div class="tl-list">
            ${tl.map((item) => `
              <div class="tl-item">
                <div class="when">${esc(item.date ? fmtDate(item.date) : "Undated")}</div>
                <div class="what">${esc(item.title)}</div>
                ${item.details ? `<div class="det">${esc(item.details)}</div>` : ""}
              </div>`).join("") || "<p class='empty'>No dated items yet.</p>"}
          </div>
        </div>
        <div class="blk sky">
          <h3>Common connections</h3>
          <div class="sec-label">People</div>${chips(peopleLinks)}
          <div class="sec-label">Pets</div>${chips(pets)}
          <div class="sec-label">Places</div>${chips(places)}
          <div class="sec-label">Likes / interests</div>${chips(likes)}
          <div class="sec-label">Organisations</div>${chips(orgs)}
        </div>
      </div>
    `;
    wrap.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => {
      const target = entityById(b.dataset.open);
      if (target && target.type === "Person") {
        renderPersonProfile(target.id);
      } else {
        setView("graph");
        selectEntity(b.dataset.open);
      }
    }));
    wrap.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openEditor("entity", b.dataset.edit)));
    wrap.querySelectorAll("[data-add-link]").forEach((b) => b.addEventListener("click", () => openEditor("link", null, b.dataset.addLink)));
  }

  function upcomingItems() {
    const items = [];
    (graph.entities || []).forEach((e) => {
      const props = e.properties || {};
      const candidates = [];
      if ((e.type === "Person" || e.type === "Pet") && props.birthday) {
        candidates.push({ date: props.birthday, recurring: props.recurring || "annual", kind: "Birthday", title: displayName(e) });
      }
      if (e.type === "Event" && (props.date || props.birthday)) {
        const kind = /birthday/i.test(String(props.kind || displayName(e))) ? "Birthday" : "Event";
        candidates.push({ date: props.date || props.birthday, recurring: props.recurring, kind, title: displayName(e) });
      }
      candidates.forEach((c) => {
        const d = nextOccurrence(c.date, c.recurring || (e.type === "Person" ? "annual" : ""));
        if (inNextDays(d, 30)) {
          items.push({ when: d, kind: c.kind, title: c.title, id: e.id, type: e.type, note: e.notes || "" });
        }
      });
    });
    items.sort((a, b) => a.when - b.when);
    // de-dupe same id+day (person birthday + birthday event)
    const seen = new Set();
    return items.filter((it) => {
      const key = it.id + ":" + it.when.toISOString().slice(0, 10) + ":" + it.kind;
      const loose = it.title + ":" + it.when.toISOString().slice(0, 10);
      if (seen.has(key) || seen.has(loose)) return false;
      seen.add(key); seen.add(loose);
      return true;
    });
  }
  function renderUpcoming() {
    const items = upcomingItems();
    const el = $("upcoming-list");
    if (!items.length) {
      el.innerHTML = "<p class='empty'>Nothing dated in the next 30 days.</p>";
      return;
    }
    el.innerHTML = items.map((it) => `
      <div class="up-item">
        <div class="when">${esc(fmtDate(it.when))}</div>
        <div>
          <div class="who"><button type="button" class="person-chip" data-open="${esc(it.id)}" style="margin:0">${esc(it.title)}</button></div>
          <small>${esc(it.kind)}${it.note ? " · " + esc(it.note) : ""}</small>
        </div>
      </div>`).join("");
    el.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => {
      const t = entityById(b.dataset.open);
      if (t && t.type === "Person") { setView("person"); renderPersonProfile(t.id); }
      else { setView("graph"); selectEntity(b.dataset.open); }
    }));
  }

  function selectEntity(id) {
    selectedId = id;
    applyGraphHighlights();
    renderPanel(id);
    bumpIdle();
  }

  function setView(name) {
    currentView = name;
    document.querySelectorAll(".nav [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.dataset.view === name));
    $("workspace").classList.toggle("no-panel", name !== "graph");
    $("panel").style.display = name === "graph" ? "" : "none";
    if (name === "person") renderPersonProfile(selectedId && entityById(selectedId) && entityById(selectedId).type === "Person" ? selectedId : ($("person-select").value || null));
    if (name === "upcoming") renderUpcoming();
    if (name === "graph") {
      redrawGraph();
      setTimeout(() => { if (cy) cy.resize(); }, 50);
    }
  }

  function renderAll() {
    renderFilters();
    redrawGraph();
    renderUpcoming();
    renderPanel(selectedId);
    if (currentView === "person") renderPersonProfile(selectedId);
  }

  /* ---------- editing ---------- */
  function markDirty() {
    dirty = true;
    graph.updated = new Date().toISOString();
  }
  function optionsForEntities(selected) {
    return (graph.entities || [])
      .slice()
      .sort((a, b) => displayName(a).localeCompare(displayName(b)))
      .map((e) => `<option value="${esc(e.id)}"${e.id === selected ? " selected" : ""}>${esc(displayName(e))} (${esc(e.type)})</option>`)
      .join("");
  }
  function openEditor(kind, id, fromId) {
    const modal = $("modal");
    const title = $("modal-title");
    const form = $("modal-form");
    modal.hidden = false;
    modal.classList.add("on");
    if (kind === "chooser") {
      title.textContent = "Add";
      form.innerHTML = `
        <p class="empty" style="margin-bottom:1rem">What would you like to add?</p>
        <div class="actions">
          ${TYPE_ORDER.map((t) => `<button type="button" class="textbtn gold" data-new-type="${esc(t)}">${esc(typeInfo(t).label)}</button>`).join("")}
          <button type="button" class="textbtn gold" data-new-link="1">Link</button>
          <button type="button" class="textbtn" id="modal-cancel">Cancel</button>
        </div>`;
      form.querySelectorAll("[data-new-type]").forEach((b) => b.addEventListener("click", () => openEditor("entity", null, b.dataset.newType)));
      form.querySelector("[data-new-link]").addEventListener("click", () => openEditor("link"));
      form.querySelector("#modal-cancel").addEventListener("click", closeModal);
      return;
    }
    if (kind === "link") {
      const existing = id ? (graph.links || []).find((l) => l.id === id) : null;
      title.textContent = existing ? "Edit link" : "Add link";
      form.innerHTML = `
        <div class="field"><label for="f-from">From</label><select id="f-from">${optionsForEntities((existing && existing.from) || fromId || "")}</select></div>
        <div class="field"><label for="f-label">Relationship label (free text)</label>
          <input id="f-label" list="label-list" value="${esc(existing ? existing.label : "")}" placeholder="mum of, friend of, lives at, owns, loves…">
          <datalist id="label-list">${LINK_SUGGESTIONS.map((s) => `<option value="${esc(s)}">`).join("")}</datalist>
        </div>
        <div class="field"><label for="f-to">To</label><select id="f-to">${optionsForEntities(existing ? existing.to : "")}</select></div>
        <div class="field"><label for="f-date">Date (optional, YYYY-MM-DD)</label><input id="f-date" value="${esc(existing ? existing.date : "")}" placeholder="2026-11-13"></div>
        <div class="field"><label for="f-status">Status</label>
          <select id="f-status">
            <option value="confirmed"${(!existing || linkStatus(existing) === "confirmed") ? " selected" : ""}>confirmed</option>
            <option value="research"${existing && linkStatus(existing) === "research" ? " selected" : ""}>research</option>
          </select>
        </div>
        <div class="field"><label for="f-confidence">Confidence (for research links)</label>
          <select id="f-confidence">
            <option value=""></option>
            ${["low","med","high"].map((c) => `<option value="${c}"${(existing && existing.confidence) === c ? " selected" : ""}>${c}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label for="f-source-url">Source URL (optional)</label><input id="f-source-url" value="${esc(existing ? (existing.source_url || "") : "")}" placeholder="https://"></div>
        <div class="field"><label for="f-notes">Notes</label><textarea id="f-notes">${esc(existing ? existing.notes : "")}</textarea></div>
        <div class="actions">
          <button type="submit" class="textbtn gold">Save link</button>
          ${existing ? `<button type="button" class="textbtn warn" id="modal-del">Delete</button>` : ""}
          <button type="button" class="textbtn" id="modal-cancel">Cancel</button>
        </div>`;
      form.onsubmit = (ev) => {
        ev.preventDefault();
        const from = $("f-from").value, to = $("f-to").value, label = $("f-label").value.trim();
        if (!from || !to || from === to) { toast("Choose two different entities."); return; }
        if (!label) { toast("Add a relationship label."); return; }
        const status = $("f-status").value === "research" ? "research" : "confirmed";
        const confidence = $("f-confidence").value;
        const source_url = $("f-source-url").value.trim();
        if (existing) {
          existing.from = from; existing.to = to; existing.label = label;
          existing.date = $("f-date").value.trim(); existing.notes = $("f-notes").value.trim();
          existing.status = status; existing.confidence = confidence; existing.source_url = source_url;
        } else {
          const ids = new Set((graph.links || []).map((l) => l.id));
          let n = 1;
          while (ids.has("L-" + String(n).padStart(4, "0"))) n += 1;
          graph.links.push({
            id: "L-" + String(n).padStart(4, "0"),
            from, to, label,
            date: $("f-date").value.trim(),
            notes: $("f-notes").value.trim(),
            status, confidence, source_url,
          });
        }
        markDirty();
        closeModal();
        renderAll();
        toast("Link saved. Click Save to encrypt a new copy.");
      };
      if (existing) $("modal-del").addEventListener("click", () => {
        if (!confirm("Delete this link?")) return;
        graph.links = graph.links.filter((l) => l.id !== existing.id);
        markDirty(); closeModal(); renderAll(); toast("Link deleted.");
      });
      $("modal-cancel").addEventListener("click", closeModal);
      return;
    }
    // entity
    const typ = id ? entityById(id).type : (fromId && TYPES[fromId] ? fromId : "Person");
    const existing = id ? entityById(id) : null;
    const props = (existing && existing.properties) || {};
    title.textContent = existing ? "Edit " + typeInfo(typ).label : "Add " + typeInfo(typ).label;
    const fields = [
      ["name", "Name / value", existing ? displayName(existing) : "", "text"],
      ["birthday", "Birthday (YYYY-MM-DD or MM-DD)", props.birthday || "", "text"],
      ["relationship", "Relationship", props.relationship || "", "text"],
      ["nickname", "Nickname", props.nickname || "", "text"],
      ["likes", "Likes", props.likes || "", "text"],
      ["dislikes", "Dislikes", props.dislikes || "", "text"],
      ["important_names", "Important names", props.important_names || "", "text"],
      ["how_we_met", "How we met", props.how_we_met || "", "text"],
      ["address", "Address", props.address || "", "text"],
      ["city", "City", props.city || "", "text"],
      ["kind", "Kind (dog, home, workplace…)", props.kind || "", "text"],
      ["date", "Date (YYYY-MM-DD)", props.date || "", "text"],
      ["recurring", "Recurring (annual / blank)", props.recurring || "", "text"],
      ["status", "Status (to raise / raised)", props.status || "", "text"],
      ["category", "Category", props.category || "", "text"],
      ["website", "Website", props.website || "", "text"],
      ["summary", "Summary", props.summary || "", "textarea"],
      ["notes", "Notes", existing ? existing.notes : "", "textarea"],
      ["sources", "Sources", existing ? existing.sources : "", "text"],
    ];
    form.innerHTML = `
      <div class="field"><label for="f-type">Type</label>
        <select id="f-type">${TYPE_ORDER.map((t) => `<option value="${t}"${t === typ ? " selected" : ""}>${esc(typeInfo(t).label)}</option>`).join("")}</select>
      </div>
      ${fields.map(([k, lab, val, typel]) => `
        <div class="field"><label for="f-${k}">${esc(lab)}</label>
          ${typel === "textarea" ? `<textarea id="f-${k}">${esc(val)}</textarea>` : `<input id="f-${k}" value="${esc(val)}">`}
        </div>`).join("")}
      <div class="actions">
        <button type="submit" class="textbtn gold">Save</button>
        <button type="button" class="textbtn" id="modal-cancel">Cancel</button>
      </div>`;
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const name = $("f-name").value.trim();
      if (!name) { toast("A name is required."); return; }
      const t = $("f-type").value;
      const newProps = {};
      ["birthday","relationship","nickname","likes","dislikes","important_names","how_we_met","address","city","kind","date","recurring","status","category","website","summary"].forEach((k) => {
        const v = $("f-" + k).value.trim();
        if (v) newProps[k] = v;
      });
      if (existing) {
        existing.type = t;
        existing.value = name;
        existing.display = name;
        existing.properties = newProps;
        existing.notes = $("f-notes").value.trim();
        existing.sources = $("f-sources").value.trim();
        existing.updated = new Date().toISOString().slice(0, 10);
        selectedId = existing.id;
      } else {
        const ent = {
          id: nextId(t), type: t, value: name, display: name,
          properties: newProps, notes: $("f-notes").value.trim(),
          sources: $("f-sources").value.trim(), updated: new Date().toISOString().slice(0, 10),
        };
        graph.entities.push(ent);
        selectedId = ent.id;
      }
      markDirty();
      closeModal();
      renderAll();
      selectEntity(selectedId);
      toast("Saved in this session. Click Save to encrypt a new copy.");
    };
    $("modal-cancel").addEventListener("click", closeModal);
  }
  function closeModal() {
    $("modal").classList.remove("on");
    $("modal").hidden = true;
    $("modal-form").onsubmit = null;
    $("modal-form").innerHTML = "";
  }
  function deleteEntity(id) {
    const e = entityById(id);
    if (!e) return;
    if (!confirm("Delete " + displayName(e) + " and its links?")) return;
    graph.entities = graph.entities.filter((x) => x.id !== id);
    graph.links = graph.links.filter((l) => l.from !== id && l.to !== id);
    if (selectedId === id) selectedId = null;
    markDirty();
    renderAll();
    renderPanel(null);
    toast("Deleted. Click Save to encrypt a new copy.");
  }

  async function saveAll() {
    if (!passphrase || !graph) return;
    try {
      const blob = await PeopleCrypto.encrypt(graph, passphrase);
      const text = JSON.stringify(blob);
      localStorage.setItem(LS_KEY, text);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      a.download = "research.enc.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      dirty = false;
      usingLocalDraft = true;
      $("local-banner").hidden = false;
      toast("Encrypted copy downloaded, and a local draft kept in this browser. Nothing was stored as plaintext.");
    } catch (e) {
      toast(e.message || "Could not encrypt.");
    }
  }

  /* ---------- wiring ---------- */
  $("unlock-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const pw = $("pw").value;
    if (!pw) return;
    unlock(pw.trim());
  });
  document.querySelectorAll(".nav [data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("btn-lock").addEventListener("click", () => lock("Locked."));
  $("btn-add").addEventListener("click", () => openEditor("chooser"));
  $("btn-save").addEventListener("click", saveAll);
  $("search").addEventListener("input", (ev) => {
    searchTerm = ev.target.value.trim();
    redrawGraph();
  });
  $("person-select").addEventListener("change", (ev) => renderPersonProfile(ev.target.value));
  $("revert-published").addEventListener("click", async () => {
    if (!passphrase || !publishedBlob) return;
    try {
      graph = await tryDecrypt(publishedBlob, passphrase);
      graph.entities.forEach((e) => { e.type = normalizeType(e.type); });
      localStorage.removeItem(LS_KEY);
      usingLocalDraft = false;
      dirty = false;
      $("local-banner").hidden = true;
      renderAll();
      toast("Reverted to the published encrypted copy.");
    } catch (e) {
      toast("Could not revert.");
    }
  });
  $("modal").addEventListener("click", (ev) => { if (ev.target === $("modal")) closeModal(); });
  ["pointerdown", "keydown", "touchstart", "wheel"].forEach((ev) => document.addEventListener(ev, bumpIdle, { passive: true }));
  window.addEventListener("beforeunload", (ev) => {
    if (dirty) { ev.preventDefault(); ev.returnValue = ""; }
  });

  window.__pmSelect = (id) => selectEntity(id);

  // Fetch the blob early so the lock screen can fail clearly, but do not decrypt.
  fetch("data.enc.json", { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error("missing"); return r.json(); })
    .then((b) => { publishedBlob = b; })
    .catch(() => { $("err").textContent = "Encrypted data file is missing. Serve this folder over http and keep data.enc.json next to index.html."; });
})();
