(() => {
  const DAY = 86400000;
  const KEY = "mangak-garden-guestbook-v1";
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const narrowQuery = window.matchMedia("(max-width: 839px)");

  const now = Date.now();
  const SEEDS = [
    { id: "seed-1", name: "익명", text: "고생 많았습니다!", at: now - 2 * DAY },
    { id: "seed-2", name: "익명", text: "와.. 대박이에요", at: now - 5 * DAY },
    { id: "seed-3", name: "익명", text: "잘 봤습니다", at: now - 9 * DAY },
    { id: "seed-4", name: "익명", text: "고생 많았다!", at: now - 14 * DAY },
    { id: "seed-5", name: "익명", text: "스티커 너무 귀여워요", at: now - 20 * DAY },
  ];

  const $ = (id) => document.getElementById(id);
  const world = $("world");
  const sky = $("sky");
  const cluster = $("cluster");
  const invite = $("invite");
  const voidEl = $("void");
  const lamp = $("lamp");
  const paper = $("paper");
  const reading = $("reading");
  const sunken = $("sunken");
  const form = $("leave-form");
  const nameInput = $("name-input");
  const textInput = $("text-input");
  const formError = $("form-error");
  const colophon = $("colophon");
  const countEl = $("count");
  const live = $("live");
  const sunkenOpen = $("sunken-open");
  const sunkenCount = $("sunken-count");
  const sunkenList = $("sunken-list");
  const readText = $("read-text");
  const readWho = $("read-who");
  const readWhen = $("read-when");
  const readRemove = $("read-remove");
  const submitBtn = form.querySelector('button[type="submit"]');

  let returnFocus = invite;
  let readingEntry = null;
  let savedOnServer = false;
  let entries = [];
  let sending = false;

  function isNarrow() {
    return narrowQuery.matches;
  }

  function normalize(entry) {
    if (!entry || typeof entry !== "object") return null;
    const name = String(entry.name || "").trim().slice(0, 12);
    const text = String(entry.text || "").trim().replace(/\s+/g, " ").slice(0, 60);
    const at = Number(entry.at);
    const id = String(entry.id || "");
    if (!name || !text || !id || !Number.isFinite(at)) return null;
    return { id, name, text, at, own: Boolean(entry.own) };
  }

  function loadLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
      if (!Array.isArray(raw)) return [];
      return raw.map((entry) => normalize({ ...entry, own: true })).filter(Boolean).slice(-40);
    } catch {
      return [];
    }
  }

  function saveLocal(list) {
    const payload = list.slice(-40).map(({ id, name, text, at }) => ({ id, name, text, at }));
    try {
      if (payload.length) localStorage.setItem(KEY, JSON.stringify(payload));
      else localStorage.removeItem(KEY);
    } catch {
      /* the garden still holds the words for this visit */
    }
  }

  function localEntries() {
    return [...loadLocal(), ...SEEDS.map((entry) => ({ ...entry, own: false }))].sort((a, b) => b.at - a.at);
  }

  function applyCopy() {
    colophon.textContent = "저희 작품을 봐주셔서 감사합니다.";
  }

  async function fetchEntries() {
    const res = await fetch("/api/entries", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (!data || data.saved !== true || !Array.isArray(data.entries)) throw new Error("shape");
    return data.entries.map(normalize).filter(Boolean);
  }

  async function postEntry(name, text) {
    const res = await fetch("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ name, text }),
    });
    if (res.status === 429) {
      const error = new Error("rate");
      error.code = "rate";
      throw error;
    }
    if (!res.ok) throw new Error("save");
    const data = await res.json();
    const entry = normalize(data.entry);
    if (!entry) throw new Error("save");
    return entry;
  }

  async function boot() {
    try {
      let remote = await fetchEntries();
      const local = loadLocal();
      const remain = [];
      for (const entry of local) {
        try {
          await postEntry(entry.name, entry.text);
        } catch {
          remain.push(entry);
        }
      }
      saveLocal(remain);
      if (local.length) remote = await fetchEntries();
      const seen = new Set(remote.map((entry) => entry.id));
      entries = [...remote, ...remain.filter((entry) => !seen.has(entry.id))].sort((a, b) => b.at - a.at);
      savedOnServer = true;
    } catch {
      savedOnServer = false;
      entries = localEntries();
    }
    applyCopy();
    render({ recenter: !parting });
  }

  function variation(id) {
    let h = 0;
    for (const ch of id) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
    return {
      tilt: `${((h % 23) - 11) / 10}deg`,
      dur: `${6.4 + (h % 28) / 10}s`,
      delay: `${-((h % 40) / 8)}s`,
      drop: 12 + (h % 20),
      h: `${206 + (h % 5) * 12}px`,
    };
  }

  function whenLabel(at) {
    const min = (Date.now() - at) / 60000;
    if (min < 1) return "방금";
    if (min < 60) return `${Math.floor(min)}분 전`;
    const hr = min / 60;
    if (hr < 24) return `${Math.floor(hr)}시간 전`;
    const day = hr / 24;
    if (day < 2) return "어제";
    if (day < 60) return `${Math.floor(day)}일 전`;
    return "오래전";
  }

  function makeHang(entry, arrive) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = arrive ? "hang is-new" : "hang";
    btn.dataset.id = entry.id;
    const days = (Date.now() - entry.at) / DAY;
    const narrow = isNarrow();
    const sink = narrow ? Math.max(0, Math.min(22, days * 0.55)) : Math.max(0, Math.min(120, days * 3.1));
    const fade = Math.max(0.45, 1 - days * 0.01);
    const look = variation(entry.id);
    btn.style.setProperty("--fade", fade.toFixed(3));
    btn.style.setProperty("--tilt", look.tilt);
    btn.style.setProperty("--dur", look.dur);
    btn.style.setProperty("--delay", look.delay);
    btn.style.setProperty("--age", Math.min(0.42, days * 0.009).toFixed(3));
    btn.style.setProperty("--h", narrow ? "210px" : look.h);

    const thread = document.createElement("span");
    thread.className = "thread";
    thread.style.height = `${Math.round((narrow ? 8 : look.drop) + sink)}px`;
    thread.setAttribute("aria-hidden", "true");

    const ring = document.createElement("span");
    ring.className = "ring";
    ring.setAttribute("aria-hidden", "true");

    const sheet = document.createElement("span");
    sheet.className = "sheet";
    const body = document.createElement("span");
    body.className = "body";
    body.textContent = entry.text;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = entry.name;
    sheet.append(body, who);
    btn.append(thread, ring, sheet);
    btn.addEventListener("click", () => openReading(entry));
    if (arrive) {
      btn.addEventListener("animationend", () => btn.classList.remove("is-new"), { once: true });
    }
    return btn;
  }

  function scrollToCenter(node, smooth) {
    if (!node) return;
    const nodeRect = node.getBoundingClientRect();
    const skyRect = sky.getBoundingClientRect();
    const next = sky.scrollLeft + (nodeRect.left + nodeRect.width / 2) - (skyRect.left + skyRect.width / 2);
    sky.scrollTo({ left: next, behavior: smooth ? "smooth" : "auto" });
  }

  function render(options = {}) {
    const { arriveId = null, recenter = false } = options;
    const sorted = entries.slice().sort((a, b) => b.at - a.at);
    const hanging = sorted;
    const sunk = [];

    const keptScroll = sky.scrollLeft;
    cluster.replaceChildren();
    const left = [];
    const right = [];
    hanging.forEach((entry, index) => (index % 2 === 0 ? right : left).push(entry));
    left.reverse();
    left.forEach((entry) => cluster.append(makeHang(entry, entry.id === arriveId)));
    const center = document.createElement("span");
    center.className = "sky-center";
    center.setAttribute("aria-hidden", "true");
    cluster.append(center);
    right.forEach((entry) => cluster.append(makeHang(entry, entry.id === arriveId)));

    sunkenOpen.hidden = sunk.length === 0;
    sunkenCount.textContent = sunk.length ? String(sunk.length) : "";
    sunkenList.replaceChildren();
    sunk.forEach((entry) => {
      const item = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      const name = document.createElement("span");
      name.className = "s-name";
      name.textContent = entry.name;
      const text = document.createElement("span");
      text.className = "s-text";
      text.textContent = entry.text;
      btn.append(name, text);
      btn.addEventListener("click", () => {
        sunken.close();
        openReading(entry);
      });
      item.append(btn);
      sunkenList.append(item);
    });

    if (arriveId || recenter) {
      requestAnimationFrame(() => {
        const target = arriveId
          ? cluster.querySelector(`[data-id="${CSS.escape(arriveId)}"]`)
          : cluster.querySelector(".sky-center");
        scrollToCenter(target, Boolean(arriveId) && !reduce);
      });
    } else if (keptScroll) {
      sky.scrollLeft = keptScroll;
    }
  }

  function openPaper() {
    returnFocus = invite;
    formError.textContent = "아직 비어있는 항목이 있습니다.";
    formError.hidden = true;
    nameInput.classList.remove("is-invalid");
    textInput.classList.remove("is-invalid");
    document.body.classList.add("is-writing");
    paper.showModal();
    nameInput.focus();
  }

  function closePaper() {
    if (paper.open) paper.close();
  }

  function openReading(entry) {
    readingEntry = entry;
    readText.textContent = entry.text;
    readWho.textContent = entry.name;
    readWhen.textContent = whenLabel(entry.at);
    readRemove.hidden = !entry.own;
    readRemove.closest(".acts").hidden = !entry.own;
    readRemove.dataset.armed = "";
    readRemove.textContent = "거두어 가다";
    document.body.classList.add("is-reading");
    reading.showModal();
    $("read-close").focus();
  }

  function idOf() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function failSave(error) {
    formError.textContent = error && error.code === "rate" ? "잠시 뒤에 다시 걸어 두어라." : "걸리지 못했다. 다시 걸어 두어라.";
    formError.hidden = false;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sending) return;
    const name = nameInput.value.trim().slice(0, 10);
    const text = textInput.value.trim().replace(/\s+/g, " ").slice(0, 60);
    nameInput.classList.toggle("is-invalid", !name);
    textInput.classList.toggle("is-invalid", !text);
    if (!name || !text) {
      formError.textContent = "아직 비어있는 항목이 있습니다.";
      formError.hidden = false;
      (name ? textInput : nameInput).focus();
      return;
    }
    sending = true;
    submitBtn.disabled = true;
    try {
      let createdId = "";
      if (savedOnServer) {
        const created = await postEntry(name, text);
        entries = await fetchEntries();
        createdId = created.id;
      } else {
        const entry = { id: idOf(), name, text, at: Date.now(), own: true };
        const own = loadLocal();
        own.push(entry);
        saveLocal(own);
        entries = localEntries();
        createdId = entry.id;
      }
      nameInput.value = "";
      textInput.value = "";
      countEl.textContent = "60";
      formError.hidden = true;
      closePaper();
      render({ arriveId: createdId });
      live.textContent = savedOnServer ? "말이 정원에 걸렸다." : "말이 이 기기에 걸렸다.";
      returnFocus = invite;
    } catch (error) {
      failSave(error);
    } finally {
      sending = false;
      submitBtn.disabled = false;
    }
  });

  textInput.addEventListener("input", () => {
    countEl.textContent = String(60 - textInput.value.length);
  });

  textInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  $("paper-cancel").addEventListener("click", closePaper);
  paper.addEventListener("click", (event) => {
    if (event.target === paper) closePaper();
  });
  paper.addEventListener("close", () => {
    document.body.classList.remove("is-writing");
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
  });

  $("read-close").addEventListener("click", () => reading.close());
  reading.addEventListener("click", (event) => {
    const sheet = reading.querySelector(".sheet-form");
    if (!sheet || !sheet.contains(event.target)) reading.close();
  });
  reading.addEventListener("close", () => {
    document.body.classList.remove("is-reading");
    readRemove.dataset.armed = "";
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
  });

  readRemove.addEventListener("click", async () => {
    if (!readingEntry || !readingEntry.own || sending) return;
    if (readRemove.dataset.armed !== "1") {
      readRemove.dataset.armed = "1";
      readRemove.textContent = "정말 거둔다";
      return;
    }
    const id = readingEntry.id;
    sending = true;
    try {
      if (savedOnServer) {
        const res = await fetch(`/api/entries/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res.ok) {
          live.textContent = "거두지 못했다.";
          return;
        }
        entries = await fetchEntries();
      } else {
        saveLocal(loadLocal().filter((entry) => entry.id !== id));
        entries = localEntries();
      }
      readingEntry = null;
      returnFocus = invite;
      reading.close();
      render({ recenter: true });
      live.textContent = "말을 거두었다.";
    } catch {
      live.textContent = "거두지 못했다.";
    } finally {
      sending = false;
    }
  });

  sunkenOpen.addEventListener("click", () => {
    returnFocus = sunkenOpen;
    sunken.showModal();
    $("sunken-close").focus();
  });
  $("sunken-close").addEventListener("click", () => sunken.close());
  sunken.addEventListener("click", (event) => {
    if (event.target === sunken) sunken.close();
  });
  sunken.addEventListener("close", () => {
    if (!reading.open && returnFocus && document.contains(returnFocus)) returnFocus.focus();
  });

  invite.addEventListener("click", openPaper);

  let drag = null;
  let blockClick = false;
  let coast = 0;

  function stopCoast() {
    if (!coast) return;
    window.cancelAnimationFrame(coast);
    coast = 0;
  }

  sky.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    stopCoast();
    drag = {
      id: event.pointerId,
      x: event.clientX,
      scroll: sky.scrollLeft,
      moved: false,
      lastX: event.clientX,
      lastT: performance.now(),
      velocity: 0,
    };
  });

  sky.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 8) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.x = event.clientX;
      drag.scroll = sky.scrollLeft;
      drag.lastX = event.clientX;
      drag.lastT = performance.now();
      sky.classList.add("is-dragging");
      if (sky.setPointerCapture) sky.setPointerCapture(event.pointerId);
      return;
    }
    const now = performance.now();
    const dt = Math.max(now - drag.lastT, 1);
    drag.velocity = (event.clientX - drag.lastX) / dt;
    drag.lastX = event.clientX;
    drag.lastT = now;
    sky.scrollLeft = drag.scroll - (event.clientX - drag.x);
  });

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const moved = drag.moved;
    let velocity = drag.velocity;
    drag = null;
    sky.classList.remove("is-dragging");
    if (!moved) return;
    blockClick = true;
    if (reduce || Math.abs(velocity) < 0.04) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(32, now - last);
      last = now;
      velocity *= Math.pow(0.86, dt / 16);
      if (Math.abs(velocity) < 0.02) {
        coast = 0;
        return;
      }
      sky.scrollLeft -= velocity * dt;
      coast = window.requestAnimationFrame(step);
    };
    coast = window.requestAnimationFrame(step);
  }

  sky.addEventListener("pointerup", endDrag);
  sky.addEventListener("pointercancel", endDrag);
  sky.addEventListener(
    "click",
    (event) => {
      if (!blockClick) return;
      blockClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );

  narrowQuery.addEventListener("change", () => render({ recenter: true }));

  window.setInterval(() => {
    if (!savedOnServer || paper.open || reading.open || sunken.open) return;
    fetchEntries()
      .then((next) => {
        entries = next;
        render();
      })
      .catch(() => {});
  }, 25000);

  const started = performance.now();
  const MIN_BLACK = 1200;
  let parting = false;
  const pending = [];

  function later(fn, ms) {
    pending.push(window.setTimeout(fn, ms));
  }

  function clearPending() {
    pending.forEach((id) => window.clearTimeout(id));
    pending.length = 0;
  }

  function part() {
    if (parting) return;
    parting = true;
    clearPending();
    document.body.classList.add("is-parting");
    window.setTimeout(() => document.body.classList.add("is-garden"), reduce ? 180 : 1800);
    window.setTimeout(() => {
      document.body.classList.add("is-settled");
      voidEl.hidden = true;
    }, reduce ? 420 : 3900);
  }

  function requestPart() {
    if (parting) return;
    const wait = Math.max(0, MIN_BLACK - (performance.now() - started));
    window.setTimeout(part, wait);
  }

  function begin() {
    if (reduce) {
      later(part, 700);
      return;
    }
    later(() => document.body.classList.add("is-line"), 1500);
    later(() => document.body.classList.add("is-hint"), 2900);
    later(part, 5200);
  }

  voidEl.addEventListener("click", requestPart);
  document.addEventListener("keydown", (event) => {
    if (voidEl.hidden || parting) return;
    if (event.key === "Enter" || event.key === " " || event.key === "Escape") {
      event.preventDefault();
      requestPart();
    }
  });

  let tx = 0;
  let ty = 0;
  let cx = 0;
  let cy = 0;
  let look = 0.5;
  let lastMove = performance.now();

  window.addEventListener("pointermove", (event) => {
    lastMove = performance.now();
    tx = event.clientX / window.innerWidth - 0.5;
    ty = event.clientY / window.innerHeight - 0.5;
    look = event.clientX / window.innerWidth;
    lamp.style.left = `${event.clientX}px`;
    lamp.style.top = `${event.clientY}px`;
  });

  function tick(nowMs) {
    if (!reduce && document.body.classList.contains("is-settled") && !isNarrow()) {
      const idle = performance.now() - lastMove > 2800;
      if (idle) {
        const t = nowMs / 1000;
        tx = Math.sin(t * 0.13) * 0.28;
        ty = Math.cos(t * 0.1) * 0.16;
        look = 0.5 + Math.sin(t * 0.13) * 0.18;
      }
      cx += (tx - cx) * 0.055;
      cy += (ty - cy) * 0.055;
      world.style.setProperty("--px", cx.toFixed(4));
      world.style.setProperty("--py", cy.toFixed(4));
      world.style.setProperty("--look", look.toFixed(4));
      world.style.setProperty("--wind", `${(cx * 7).toFixed(3)}deg`);
    }
    window.requestAnimationFrame(tick);
  }

  entries = localEntries();
  applyCopy();
  render({ recenter: true });
  begin();
  boot();
  window.requestAnimationFrame(tick);
})();
