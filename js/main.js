// Footer year
document.getElementById('year').textContent = new Date().getFullYear();

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

// Haul quiz — routes the customer to the right pricing tab
const quiz = document.getElementById('haul-quiz');
if (quiz) {
  const RESULTS = {
    'household|self':    { tab: 'residential', title: '15-Yard Roll-Off Rental', copy: "A self-load dumpster is the most affordable way to clear out household junk and furniture on your own schedule.", amigo: true },
    'household|crew':    { tab: 'junk',        title: 'Full-Service Junk Hauling', copy: "Skip the lifting — our crew loads and hauls your household junk and furniture away, start to finish.", amigo: false },
    'renovation|self':   { tab: 'residential', title: '15-Yard Roll-Off Rental', copy: "A self-load dumpster on site lets your crew or family toss remodel debris as the project moves.", amigo: true },
    'renovation|crew':   { tab: 'junk',        title: 'Full-Service Junk Hauling', copy: "Let our crew load and remove your remodel debris so you can stay focused on the project.", amigo: false },
    'yard|self':         { tab: 'yard',        title: 'Yard Waste Roll-Off Rental', copy: "Drop a dumpster on site and load brush, branches and yard debris on your own time.", amigo: true },
    'yard|crew':         { tab: 'yard',        title: 'Full-Service Brush Hauling', copy: "Our crew loads and hauls your yard waste and brush away — no dumpster required.", amigo: false },
    'heavy':              { tab: 'heavy',       title: 'Heavy Material Pricing', copy: "Concrete, dirt, brick and similar material is priced by weight, not container size — see rates below.", amigo: true },
    'contractor':         { tab: 'contractor',  title: 'Contractor & Repeat-Account Pricing', copy: "Volume rates for builders, roofers and property managers — pricing improves automatically with your monthly usage.", amigo: true },
    'unsure':              { tab: 'residential', title: "Start Here — 15-Yard Roll-Off Rental", copy: "Our most popular option while you figure out the details. Call us and we'll help dial in the right fit.", amigo: true },
  };

  const steps = quiz.querySelectorAll('.quiz-step');
  const resultPanel = quiz.querySelector('.quiz-result');
  const resultTitle = document.getElementById('quiz-result-title');
  const resultCopy = document.getElementById('quiz-result-copy');
  const resultCta = document.getElementById('quiz-result-cta');
  const amigoBox = document.getElementById('quiz-amigo');
  let chosenType = null;

  const showStep = (name) => {
    steps.forEach(s => s.classList.toggle('active', s.dataset.step === name));
    resultPanel.classList.toggle('active', name === 'result');
  };

  const showResult = (key) => {
    const result = RESULTS[key];
    if (!result) return;
    resultTitle.textContent = result.title;
    resultCopy.textContent = result.copy;
    resultCta.dataset.tab = result.tab;
    amigoBox.hidden = !result.amigo;
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

// Netlify form -> AJAX submit with inline success state
const form = document.getElementById('quote-form');
if (form) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = new FormData(form);
    fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(data).toString(),
    })
      .then(() => {
        document.getElementById('form-fields').style.display = 'none';
        document.getElementById('form-success').classList.add('show');
      })
      .catch(() => {
        form.submit();
      });
  });
}
