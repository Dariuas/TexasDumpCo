// Shared month-view availability calendar — used by the customer booking
// flow (/book) and the admin "New Booking" form (/admin) so both surfaces
// let someone browse open dates instead of guessing-and-checking one at a time.

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const WEEKDAYS = ["Su","Mo","Tu","We","Th","Fr","Sa"];

function ymd(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return { y, m, d };
}
function monthKey(y, m) { return `${y}-${String(m).padStart(2, "0")}`; }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function cmpMonth(a, b) { return a.y !== b.y ? a.y - b.y : a.m - b.m; }

/**
 * @param {HTMLElement} container
 * @param {object} opts
 *   apiBase?: string (default '/api')
 *   typeId: string
 *   days: number              — length of the booking; a day cell shows
 *                                whether a booking of this length can START there
 *   minDate: 'YYYY-MM-DD'
 *   maxDate: 'YYYY-MM-DD'
 *   selectedDate?: 'YYYY-MM-DD'
 *   onSelect: (dateStr: string) => void
 * @returns {{ setDays(n:number):void, setType(id:string):void, setSelected(d:string):void, destroy():void }}
 */
export function mountAvailabilityCalendar(container, opts) {
  const apiBase = opts.apiBase || "/api";
  const state = {
    typeId: opts.typeId,
    days: opts.days || 1,
    minDate: opts.minDate,
    maxDate: opts.maxDate,
    selected: opts.selectedDate || null,
  };
  const min = ymd(state.minDate);
  const max = ymd(state.maxDate);
  let view = { y: min.y, m: min.m };
  let destroyed = false;

  container.classList.add("avail-cal");

  async function fetchMonth() {
    const res = await fetch(`${apiBase}/availability-calendar?type=${state.typeId}&days=${state.days}&month=${monthKey(view.y, view.m)}`);
    if (!res.ok) throw new Error("Could not load availability");
    return res.json();
  }

  function render(availability) {
    if (destroyed) return;
    const first = new Date(Date.UTC(view.y, view.m - 1, 1));
    const offset = first.getUTCDay();
    const total = daysInMonth(view.y, view.m);
    const atMin = cmpMonth(view, min) <= 0;
    const atMax = cmpMonth(view, max) >= 0;

    let cells = "";
    for (let i = 0; i < offset; i++) cells += `<span class="ac-cell ac-blank"></span>`;
    for (let d = 1; d <= total; d++) {
      const dateStr = `${view.y}-${String(view.m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const outOfRange = dateStr < state.minDate || dateStr > state.maxDate;
      const avail = availability[dateStr] ?? 0;
      const full = avail <= 0;
      const disabled = outOfRange || full;
      const selected = dateStr === state.selected;
      cells += `<button type="button" class="ac-cell ac-day${disabled ? " ac-disabled" : " ac-open"}${selected ? " ac-selected" : ""}"
        data-date="${dateStr}" ${disabled ? "disabled" : ""} title="${outOfRange ? "Not bookable" : full ? "Fully booked" : "Available"}">${d}</button>`;
    }

    container.innerHTML = `
      <div class="ac-head">
        <button type="button" class="ac-nav" data-nav="-1" ${atMin ? "disabled" : ""} aria-label="Previous month">‹</button>
        <span class="ac-month">${MONTH_NAMES[view.m - 1]} ${view.y}</span>
        <button type="button" class="ac-nav" data-nav="1" ${atMax ? "disabled" : ""} aria-label="Next month">›</button>
      </div>
      <div class="ac-grid ac-weekdays">${WEEKDAYS.map((w) => `<span class="ac-cell ac-wd">${w}</span>`).join("")}</div>
      <div class="ac-grid">${cells}</div>
      <div class="ac-legend"><span class="ac-dot ac-open"></span> Available <span class="ac-dot ac-disabled"></span> Full / unavailable</div>`;

    container.querySelectorAll(".ac-nav").forEach((btn) => btn.addEventListener("click", () => {
      const dir = Number(btn.dataset.nav);
      const next = { y: view.y + (view.m + dir > 12 ? 1 : view.m + dir < 1 ? -1 : 0), m: ((view.m + dir + 11) % 12) + 1 };
      if (dir < 0 && cmpMonth(next, min) < 0) return;
      if (dir > 0 && cmpMonth(next, max) > 0) return;
      view = next;
      load();
    }));
    container.querySelectorAll(".ac-day.ac-open").forEach((btn) => btn.addEventListener("click", () => {
      state.selected = btn.dataset.date;
      container.querySelectorAll(".ac-day").forEach((c) => c.classList.remove("ac-selected"));
      btn.classList.add("ac-selected");
      opts.onSelect(state.selected);
    }));
  }

  async function load() {
    container.innerHTML = `<p class="ac-loading">Loading availability…</p>`;
    try {
      const res = await fetchMonth();
      render(res.availability);
    } catch (err) {
      container.innerHTML = `<p class="ac-loading">${err.message}</p>`;
    }
  }

  load();

  return {
    setDays(n) { state.days = n; load(); },
    setType(id) { state.typeId = id; load(); },
    setSelected(d) { state.selected = d; load(); },
    destroy() { destroyed = true; container.innerHTML = ""; },
  };
}
