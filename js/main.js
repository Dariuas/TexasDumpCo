// Footer year
document.getElementById('year').textContent = new Date().getFullYear();

// Live pricing: overwrite the static fallback numbers in the markup with
// current prices from the admin-editable catalog, so admin edits show up
// here without a code deploy. Fails silently, leaving the static fallback.
let applyLivePrices = () => {};
(async () => {
  try {
    const res = await fetch('/api/catalog');
    if (!res.ok) return;
    const { types = [], tiers = [], addons = [] } = await res.json();

    const byCat = {};
    types.forEach((t) => { (byCat[t.category] ??= []).push(t); });
    Object.values(byCat).forEach((list) => list.sort((a, b) => a.sort_order - b.sort_order));

    const tiersByType = {};
    tiers.forEach((tr) => { (tiersByType[tr.type_id] ??= {})[tr.days] = tr.price_cents; });

    const fmt = (cents) => `$${Math.round(cents / 100)}`;

    applyLivePrices = () => document.querySelectorAll('[data-price-cat]').forEach((el) => {
      const list = byCat[el.dataset.priceCat];
      if (!list || !list.length) return;
      const idx = el.dataset.priceIdx !== undefined ? Number(el.dataset.priceIdx) : 0;
      const type = list[idx];
      if (!type) return;
      const cents = el.dataset.priceDays !== undefined
        ? tiersByType[type.id]?.[Number(el.dataset.priceDays)]
        : type.base_price_cents;
      if (cents != null) el.textContent = fmt(cents);
    });
    applyLivePrices();

    // Roll-off rate cards (Standard / Heavy / Yard waste): included weight + extra rate per
    // material, from each type's weight settings in Back Office -> Prices & add-ons.
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
    document.querySelectorAll('[data-rate-cat]').forEach((card) => {
      const t = byCat[card.dataset.rateCat]?.[0];
      if (!t) { card.hidden = true; return; }
      const terms = card.querySelector('[data-rate-terms]');
      if (terms && t.weight_limit_tons != null && t.overage_fee_cents > 0) {
        const lb = Math.round(t.weight_limit_tons * 2000).toLocaleString('en-US');
        terms.textContent = `Roll-off includes ${lb} lb; additional weight ${fmt(t.overage_fee_cents / 2)} per 1,000 lb.`;
      }
    });
    const loads = addons.filter((a) => a.category === 'brush_load');
    const loadList = document.getElementById('rc-loads');
    if (loadList && loads.length) {
      loadList.innerHTML = '<li><strong>1/4 Load</strong><span>3.5 yards &middot; included</span></li>' +
        loads.map((a) => {
          const [name, size] = a.name.split(/\s*\(/);
          return `<li><strong>${esc(name)}</strong><span>${size ? esc(size.replace(/\)$/, '')) + ' &middot; ' : ''}+${fmt(a.price_cents)}</span></li>`;
        }).join('');
    }
    // Junk hauling special items: the add-on items customers can tick when booking.
    const junkItems = addons.filter((a) => a.category !== 'brush_load');
    const junkEl = document.getElementById('junk-addons');
    if (junkEl && junkItems.length) {
      junkEl.innerHTML = junkItems.map((a) => `${esc(a.name)} ${fmt(a.price_cents)}`).join(' &middot; ');
    }

    // Standard roll-off terms quoted in the copy (Inventory tab: extra day, overage, included weight).
    const std = byCat.roll_off_standard?.[0];
    if (std) {
      setLive('std_extra_day', std.extra_day_fee_cents != null && fmt(std.extra_day_fee_cents));
      setLive('std_overage', std.overage_fee_cents != null && fmt(std.overage_fee_cents));
      if (std.weight_limit_tons != null) {
        setLive('std_tons', String(Number(std.weight_limit_tons)));
        setLive('std_lbs', Math.round(std.weight_limit_tons * 2000).toLocaleString('en-US'));
      }
    }
  } catch {
    // Catalog unreachable — keep the static fallback prices already in the HTML.
  }
})();

// Fill every <span data-live="key"> with a value (no-op when the value is missing).
function setLive(key, text) {
  if (!text) return;
  document.querySelectorAll(`[data-live="${key}"]`).forEach((el) => { el.textContent = text; });
}

// Admin Settings values (one shared fetch). Each consumer keeps its static fallback if this fails.
const publicConfig = fetch('/api/public-config').then((r) => (r.ok ? r.json() : null)).catch(() => null);

// Phone number and mileage pricing from Back Office -> Settings.
(async () => {
  const cfg = await publicConfig;
  if (!cfg) return;
  const digits = (cfg.companyPhone || '').replace(/\D/g, '');
  if (digits.length >= 10) {
    setLive('phone', cfg.companyPhone);
    const tel = `tel:${digits.length === 10 ? '1' + digits : digits}`;
    document.querySelectorAll('[data-live-phone]').forEach((a) => { a.href = tel; });
  }
  const dp = cfg.distancePricing;
  if (dp) {
    setLive('free_radius', String(dp.free_radius_miles));
    setLive('per_mile', `$${(dp.per_mile_cents / 100).toFixed(2)}`);
  }
})();

// Live contractor pricing: same fallback-overwrite pattern as above, sourced
// from the admin-editable contractor rate card (Settings tab) instead of the
// dumpster_types catalog, since contractor accounts are quote_only and not a
// public catalog row.
(async () => {
  const els = document.querySelectorAll('[data-contractor-key]');
  if (!els.length) return;
  const cfg = await publicConfig;
  if (!cfg) return;
  const contractorRateCard = cfg.contractorRateCard || {};
  const fmt = (cents) => `$${Math.round(cents / 100)}`;
  els.forEach((el) => {
    const cents = contractorRateCard[el.dataset.contractorKey];
    if (cents == null) return;
    const suffix = el.textContent.trim().endsWith('each') ? ' each' : '';
    el.textContent = fmt(cents) + suffix;
  });
})();

// Mobile nav toggle
const navToggle = document.getElementById('nav-toggle');
const mainNav = document.getElementById('main-nav');
if (navToggle) {
  navToggle.addEventListener('click', () => {
    const open = mainNav.classList.toggle('open');
    if (open) {
      mainNav.style.cssText = 'display:block;position:absolute;top:100%;left:0;right:0;background:#0b0b0c;border-top:2px solid #ffc61a;padding:18px 24px;';
      mainNav.querySelector('ul').style.cssText = 'flex-direction:column;gap:18px;';
    } else {
      mainNav.removeAttribute('style');
    }
  });
  mainNav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
    mainNav.classList.remove('open');
    mainNav.removeAttribute('style');
  }));
}

// Pricing tabs
const tabs = document.querySelectorAll('.pricing-tab');
const panels = document.querySelectorAll('.pricing-panel');
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.setAttribute('aria-selected', 'false'));
    tab.setAttribute('aria-selected', 'true');
    const target = tab.dataset.tab;
    panels.forEach(p => p.classList.toggle('active', p.dataset.panel === target));
  });
});
// In-text links that open another pricing tab (e.g. "see Fees & Policies").
document.querySelectorAll('[data-goto-tab]').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  document.querySelector(`.pricing-tab[data-tab="${a.dataset.gotoTab}"]`)?.click();
}));

// Haul quiz — routes the customer to the right pricing tab
const quiz = document.getElementById('haul-quiz');
if (quiz) {
  const RESULTS = {
    'household|self':    { tab: 'residential', title: '14-Yard Roll-Off Rental', copy: "A self-load dumpster is the most affordable way to clear out household junk and furniture on your own schedule.", amigo: true },
    'household|crew':    { tab: 'junk',        title: 'Full-Service Junk Hauling', copy: "Skip the lifting — our crew loads and hauls your household junk and furniture away, start to finish.", amigo: false },
    'renovation|self':   { tab: 'residential', title: '14-Yard Roll-Off Rental', copy: "A self-load dumpster on site lets your crew or family toss remodel debris as the project moves.", amigo: true },
    'renovation|crew':   { tab: 'junk',        title: 'Full-Service Junk Hauling', copy: "Let our crew load and remove your remodel debris so you can stay focused on the project.", amigo: false },
    'yard|self':         { tab: 'residential', title: 'Yard Waste Roll-Off Rental', copy: "Drop a dumpster on site and load brush, branches and yard debris on your own time.", amigo: true },
    'yard|crew':         { tab: 'junk',        title: 'Full-Service Brush Hauling', copy: "Our crew loads and hauls your yard waste and brush away — no dumpster required.", amigo: false },
    'heavy':              { tab: 'residential', title: 'Heavy Materials Roll-Off', copy: "Concrete, dirt, brick, rock, shingles and similar material go in a Heavy Materials roll-off — see the included weight and rates below.", amigo: true },
    'contractor':         { tab: 'contractor',  title: 'Contractor & Repeat-Account Pricing', copy: "Volume rates for builders, roofers and property managers — pricing improves automatically with your monthly usage.", amigo: true },
    'unsure':              { tab: 'residential', title: "Start Here — 14-Yard Roll-Off Rental", copy: "Our most popular option while you figure out the details. Call us and we'll help dial in the right fit.", amigo: true },
  };

  const steps = quiz.querySelectorAll('.quiz-step');
  const resultPanel = quiz.querySelector('.quiz-result');
  const resultTitle = document.getElementById('quiz-result-title');
  const resultCopy = document.getElementById('quiz-result-copy');
  const resultCta = document.getElementById('quiz-result-cta');
  let chosenType = null;

  const showStep = (name) => {
    steps.forEach(s => s.classList.toggle('active', s.dataset.step === name));
    resultPanel.classList.toggle('active', name === 'result');
  };

  const bookCta = document.getElementById('quiz-book-cta');
  const showResult = (key) => {
    const result = RESULTS[key];
    if (!result) return;
    resultTitle.textContent = result.title;
    resultCopy.textContent = result.copy;
    resultCta.dataset.tab = result.tab;
    // Everything is now bookable online: dumpster rentals (amigo:true) and
    // full-service junk/brush hauling (amigo:false) each deep-link to /book
    // with the right service pre-selected.
    const service = result.amigo ? 'dumpster' : 'junk';
    if (bookCta) bookCta.href = `/book/?service=${service}`;
    showStep('result');
  };

  quiz.querySelectorAll('[data-step="1"] .quiz-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      chosenType = btn.dataset.type;
      if (chosenType === 'household' || chosenType === 'renovation' || chosenType === 'yard') {
        showStep('2');
      } else {
        showResult(chosenType);
      }
    });
  });

  quiz.querySelectorAll('[data-step="2"] .quiz-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      showResult(`${chosenType}|${btn.dataset.handling}`);
    });
  });

  quiz.querySelector('.quiz-back').addEventListener('click', () => showStep('1'));
  quiz.querySelector('.quiz-restart').addEventListener('click', () => {
    chosenType = null;
    showStep('1');
  });

  resultCta.addEventListener('click', (e) => {
    e.preventDefault();
    const targetTab = document.querySelector(`.pricing-tab[data-tab="${resultCta.dataset.tab}"]`);
    if (targetTab) targetTab.click();
    document.getElementById('pricing').scrollIntoView({ behavior: 'smooth' });
  });
}

// Quote form: photos upload straight to private storage (signed URL), then the request is
// stored via /api/quote-request. If that fails we fall back to the original Netlify form post
// so a request is never lost (photo links are included in the fallback).
const form = document.getElementById('quote-form');
if (form) {
  const fileInput = document.getElementById('quote-photos');
  const thumbs = document.getElementById('quote-thumbs');
  const photoMsg = document.getElementById('quote-photo-msg');
  const submitBtn = form.querySelector('button[type=submit]');
  const photos = []; // { path, name }
  let uploading = 0;
  let sbClient = null;
  const MAX_PHOTOS = 6, MAX_BYTES = 10 * 1024 * 1024;
  const contractorBox = document.getElementById('q-contractor');
  if (contractorBox) contractorBox.addEventListener('change', () => {
    document.getElementById('q-contractor-field').hidden = !contractorBox.checked;
  });

  async function client() {
    if (sbClient) return sbClient;
    const cfg = await fetch('/api/public-config').then((r) => r.json());
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.45.4');
    sbClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    return sbClient;
  }

  fileInput.addEventListener('change', async () => {
    photoMsg.textContent = '';
    for (const file of Array.from(fileInput.files || [])) {
      if (photos.length + uploading >= MAX_PHOTOS) { photoMsg.textContent = `Up to ${MAX_PHOTOS} photos.`; break; }
      if (file.size > MAX_BYTES) { photoMsg.textContent = `${file.name} is over 10 MB.`; continue; }
      const thumb = document.createElement('div');
      thumb.className = 'thumb uploading';
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      thumb.appendChild(img);
      thumbs.appendChild(thumb);
      uploading++; submitBtn.disabled = true;
      try {
        const up = await fetch('/api/upload-url', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filename: file.name, content_type: file.type }),
        }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Upload failed'); return d; });
        const sb = await client();
        const { error } = await sb.storage.from('booking-uploads').uploadToSignedUrl(up.path, up.token, file);
        if (error) throw error;
        photos.push({ path: up.path, name: file.name });
        thumb.classList.remove('uploading');
        const rm = document.createElement('button');
        rm.type = 'button'; rm.textContent = '×'; rm.setAttribute('aria-label', 'Remove photo');
        rm.addEventListener('click', () => { const i = photos.findIndex((p) => p.path === up.path); if (i > -1) photos.splice(i, 1); thumb.remove(); });
        thumb.appendChild(rm);
      } catch (err) {
        thumb.remove(); photoMsg.textContent = `Could not upload ${file.name}: ${err.message || 'try again'}`;
      } finally {
        uploading--; if (!uploading) submitBtn.disabled = false;
      }
    }
    fileInput.value = '';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (uploading || submitBtn.disabled) return;
    submitBtn.disabled = true;
    const data = Object.fromEntries(new FormData(form));
    const done = () => {
      document.getElementById('form-fields').style.display = 'none';
      document.getElementById('form-success').classList.add('show');
    };
    try {
      const res = await fetch('/api/quote-request', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...data, photos: photos.map((p) => p.path) }),
      });
      if (!res.ok) throw new Error('quote-request failed');
      done();
    } catch {
      // Fallback: original Netlify form capture.
      const body = new URLSearchParams({ ...data, photo_count: String(photos.length), photo_paths: photos.map((p) => p.path).join(', ') });
      fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
        .then(done).catch(() => { submitBtn.disabled = false; alert('Could not send. Please call (512) 337-4340.'); });
    }
  });
}

// ON SITE carousel: slides are admin-editable (Back Office -> Site Carousel). The static
// 7-day card in the HTML stays as the fallback if the slides API is unreachable or empty.
(async () => {
  const root = document.getElementById('hero-carousel');
  if (!root) return;
  const track = document.getElementById('carousel-track');
  const controls = document.getElementById('carousel-controls');
  const dotsEl = document.getElementById('carousel-dots');
  let slides = [];
  try {
    const res = await fetch('/api/site-slides');
    if (!res.ok) return;
    ({ slides = [] } = await res.json());
  } catch { return; }
  if (!slides.length) return;

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const safeUrl = (u) => (/^(https?:\/\/|\/|#|tel:|mailto:)/i.test(u || '') ? u : '#');
  track.innerHTML = slides.map((s) => {
    const bullets = (s.bullets || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const price = s.live_price
      ? `<div class="hero-price"><span class="per">${esc(s.price_label || 'starting at')}</span><span class="amt" data-price-cat="roll_off_standard" data-price-days="7">$419</span></div>`
      : s.price_text
        ? `<div class="hero-price"><span class="per">${esc(s.price_label || '')}</span><span class="amt">${esc(s.price_text)}</span></div>`
        : '';
    return `<div class="carousel-slide" data-badge="${esc(s.badge || '')}">
      ${s.image_url ? `<img class="slide-img" src="${esc(safeUrl(s.image_url))}" alt="">` : ''}
      <h3>${esc(s.title)}</h3>
      ${s.body ? `<p>${esc(s.body)}</p>` : ''}
      ${price}
      ${bullets.length ? `<ul class="hero-panel-list">${bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
      ${s.cta_label ? `<a href="${esc(safeUrl(s.cta_url))}" class="btn btn-dark btn-block">${esc(s.cta_label)}</a>` : ''}
    </div>`;
  }).join('');
  applyLivePrices();

  const els = [...track.querySelectorAll('.carousel-slide')];
  let i = 0, timer;
  const show = (n) => {
    i = (n + els.length) % els.length;
    els.forEach((el, k) => el.classList.toggle('active', k === i));
    dotsEl.querySelectorAll('.carousel-dot').forEach((d, k) => d.classList.toggle('active', k === i));
    // The yellow ribbon on the panel shows the current slide's badge (hidden when blank).
    const badge = els[i].dataset.badge;
    root.dataset.badge = badge || '';
    root.classList.toggle('no-badge', !badge);
  };
  const restart = () => { clearInterval(timer); if (els.length > 1) timer = setInterval(() => show(i + 1), 7000); };
  if (els.length > 1) {
    controls.hidden = false;
    dotsEl.innerHTML = els.map((_, k) => `<button type="button" class="carousel-dot" aria-label="Slide ${k + 1}"></button>`).join('');
    dotsEl.querySelectorAll('.carousel-dot').forEach((d, k) => d.addEventListener('click', () => { show(k); restart(); }));
    document.getElementById('carousel-prev').addEventListener('click', () => { show(i - 1); restart(); });
    document.getElementById('carousel-next').addEventListener('click', () => { show(i + 1); restart(); });
    root.addEventListener('mouseenter', () => clearInterval(timer));
    root.addEventListener('mouseleave', restart);
    let x0 = null;
    root.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    root.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) { show(i + (dx < 0 ? 1 : -1)); restart(); }
      x0 = null;
    });
  }
  show(0);
  restart();
})();

// Fee schedule tab: rows come from the admin-editable fee schedule (Back Office -> Settings).
(async () => {
  const body = document.getElementById('fee-rows');
  if (!body) return;
  const cfg = await publicConfig;
  if (!cfg || !Array.isArray(cfg.feeSchedule)) return; // keep static fallback rows
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  body.innerHTML = cfg.feeSchedule.map((f) => {
    if (f.amount_cents == null) return `<tr><td>${esc(f.label)}</td><td class="price">Call for price</td><td>${esc(f.note).replace(/\n/g, '<br>')}</td></tr>`;
    const amt = `$${(f.amount_cents / 100).toFixed(f.amount_cents % 100 ? 2 : 0)}`;
    return `<tr><td>${esc(f.label)}</td><td class="price">${f.from ? 'from ' : ''}${amt}${f.unit ? ' / ' + esc(f.unit) : ''}</td><td>${esc(f.note).replace(/\n/g, '<br>')}</td></tr>`;
  }).join('') || '<tr><td colspan="3">No additional fees.</td></tr>';
})();

// Contractor application: goes to the admin queue; the number is emailed after approval.
(() => {
  const form = document.getElementById('contractor-form');
  if (!form) return;
  const msg = document.getElementById('contractor-msg');
  const btn = form.querySelector('button[type=submit]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true; msg.className = 'contractor-msg'; msg.textContent = 'Submitting…';
    try {
      const res = await fetch('/api/contractor-signup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          company_name: document.getElementById('ct-company').value, contact_name: document.getElementById('ct-contact').value,
          email: document.getElementById('ct-email').value, phone: document.getElementById('ct-phone').value,
          license_info: document.getElementById('ct-info').value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      msg.className = 'contractor-msg ok';
      if (data.status === 'approved' && data.contractor_number) {
        msg.innerHTML = `You're already approved. Your contractor number is <strong>${data.contractor_number}</strong>. Use it when you book online.`;
      } else if (data.status === 'rejected' || data.status === 'suspended') {
        msg.textContent = 'We already have an application with these details. Please call us about your contractor account.';
      } else {
        msg.textContent = data.existing
          ? "We already have your application and are verifying it. We'll email your contractor number once you're approved."
          : "Application received. We'll verify your business and email your contractor number once you're approved.";
      }
      form.reset();
    } catch (err) {
      msg.className = 'contractor-msg err'; msg.textContent = err.message;
    } finally { btn.disabled = false; }
  });
})();
