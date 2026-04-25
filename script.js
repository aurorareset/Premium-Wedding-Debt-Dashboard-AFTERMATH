/* ============================================
   AFTERMATH — Wedding Debt Recovery System
   Application Logic
   ============================================

   Fully self-contained. No external JS libraries.
   Chart rendered as pure inline SVG.

   This file handles:
   - localStorage persistence (all data local, no backend)
   - Setup flow (onboarding)
   - Tab navigation
   - Next Action logic (system-generated)
   - Payment logging
   - Spending logging (optional, non-judgmental)
   - Milestone triggering
   - Weekly reset logic
   - Progress chart rendering (pure SVG, no CDN)
   ============================================ */

/* ============================================
   CONSTANTS
   ============================================ */
const STORAGE_KEY = 'aftermath_data';

// Default state shape — one source of truth.
const DEFAULT_STATE = {
  setup: {
    totalDebt: 0,
    monthlyPayment: 0,
    sourceCount: 0,
    debtSources: [], // [{ id, name, amount, paid }]
    startDate: null,
  },
  payments: [],      // [{ date, amount }]
  spending: [],      // [{ id, date, amount, note }]
  currentWeek: {
    weekStart: null, // ISO date string (Monday of current week)
    goal: 0,
    checklist: [],   // [{ id, item, done }]
    paymentLogged: false,
  },
  milestones: {
    m1000: false,
    m2500: false,
    m50: false,
  },
  // A simple log of which week-start dates have been announced as "new week"
  // so the reset banner only shows once per week.
  announcedWeeks: [],
};

/* ============================================
   STATE MANAGEMENT
   ============================================ */

// In-memory app state — mirrors localStorage.
let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    // Shallow-merge with defaults to handle future schema additions safely.
    return {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      setup: { ...DEFAULT_STATE.setup, ...(parsed.setup || {}) },
      currentWeek: { ...DEFAULT_STATE.currentWeek, ...(parsed.currentWeek || {}) },
      milestones: { ...DEFAULT_STATE.milestones, ...(parsed.milestones || {}) },
    };
  } catch (err) {
    console.error('Failed to load state, starting fresh.', err);
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error('Failed to save state:', err);
  }
}

/* ============================================
   UTILITIES
   ============================================ */

// Currency formatting — rounded, no decimals for clean display
function fmtMoney(n) {
  const rounded = Math.round(Number(n) || 0);
  return '$' + rounded.toLocaleString('en-US');
}

// Date formatting: "Apr 20"
function fmtShortDate(isoDate) {
  const d = new Date(isoDate);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Get Monday of a given date's week (ISO-style: week starts Monday)
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sun, 1 = Mon...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function weekStartISO(date = new Date()) {
  return getMonday(date).toISOString().split('T')[0];
}

// Sum helper
function sum(arr, key) {
  return arr.reduce((acc, item) => acc + (Number(item[key]) || 0), 0);
}

/* ============================================
   COMPUTED VALUES
   ============================================ */

function totalPaid() {
  return sum(state.payments, 'amount');
}

function totalRemaining() {
  return Math.max(0, state.setup.totalDebt - totalPaid());
}

function percentComplete() {
  if (!state.setup.totalDebt) return 0;
  return Math.min(100, Math.round((totalPaid() / state.setup.totalDebt) * 100));
}

function monthsRemaining() {
  if (!state.setup.monthlyPayment) return 0;
  return Math.ceil(totalRemaining() / state.setup.monthlyPayment);
}

// Weekly goal = monthly payment / 4 (simple, predictable)
function weeklyGoal() {
  return Math.round(state.setup.monthlyPayment / 4);
}

/* ============================================
   SETUP FLOW
   ============================================ */

function showSetup() {
  document.getElementById('setup-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function showApp() {
  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  renderAll();
}

function initSetupForm() {
  const form = document.getElementById('setup-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();

    const totalDebt = parseFloat(document.getElementById('setup-debt').value);
    const monthlyPayment = parseFloat(document.getElementById('setup-monthly').value);
    const sourceCount = parseInt(document.getElementById('setup-sources').value) || 0;

    if (!totalDebt || !monthlyPayment || totalDebt < 1 || monthlyPayment < 1) {
      return;
    }

    // Initialize setup
    state.setup.totalDebt = totalDebt;
    state.setup.monthlyPayment = monthlyPayment;
    state.setup.sourceCount = sourceCount;
    state.setup.startDate = todayISO();

    // If user declared sources, create blank placeholders they can name in Settings.
    state.setup.debtSources = [];
    if (sourceCount > 0) {
      const perSource = Math.round(totalDebt / sourceCount);
      for (let i = 0; i < sourceCount; i++) {
        state.setup.debtSources.push({
          id: `src_${Date.now()}_${i}`,
          name: `Debt ${i + 1}`,
          amount: perSource,
          paid: 0,
        });
      }
    }

    // Initialize first week
    initializeNewWeek();

    saveState();
    showApp();
  });
}

/* ============================================
   WEEKLY CYCLE LOGIC
   ============================================ */

// Build the default weekly checklist
function defaultChecklist() {
  return [
    { id: 'c1', item: 'Confirm payment sent', done: false },
    { id: 'c2', item: 'Log payment in app',   done: false },
    { id: 'c3', item: 'Review your week (optional)', done: false },
  ];
}

// Initialize a fresh weekly cycle
function initializeNewWeek() {
  const weekStart = weekStartISO();
  state.currentWeek = {
    weekStart,
    goal: weeklyGoal(),
    checklist: defaultChecklist(),
    paymentLogged: false,
  };
}

// Check if we've crossed into a new week since last save.
// Returns true if a reset happened.
function checkWeeklyReset() {
  const currentWeekStart = weekStartISO();
  if (state.currentWeek.weekStart !== currentWeekStart) {
    // Roll over into new week
    initializeNewWeek();
    saveState();
    return true;
  }
  return false;
}

/* ============================================
   NEXT ACTION LOGIC (system-generated)
   ============================================

   Priority order:
   1. If debt fully paid → celebratory "complete" state
   2. If payment not yet logged this week → "Log My $X Payment"
   3. If payment logged, checklist incomplete → "Mark This Week Complete"
   4. If checklist complete → "You're done. Next week starts Monday."
   ============================================ */

function computeNextAction() {
  if (totalRemaining() <= 0) {
    return {
      title: "You've paid it all off.",
      subtitle: "Every debt cleared. This is the moment you were working toward.",
      btnLabel: 'View Progress',
      action: () => switchTab('progress'),
    };
  }

  const goal = state.currentWeek.goal;
  const checklistDone = state.currentWeek.checklist.every(c => c.done);

  if (!state.currentWeek.paymentLogged) {
    return {
      title: `Make your ${fmtMoney(goal)} payment this week`,
      subtitle: 'One intentional payment toward your recovery. That is all this week asks of you.',
      btnLabel: `LOG PAYMENT`,
      action: () => openLogPaymentModal(goal),
    };
  }

  if (!checklistDone) {
    return {
      title: 'Finish this week strong',
      subtitle: 'Payment logged. Complete your checklist in the Plan tab to close out the week.',
      btnLabel: 'Mark This Week Complete',
      action: () => switchTab('plan'),
    };
  }

  return {
    title: 'This week is complete',
    subtitle: 'Rest. A new week starts Monday. You are doing this.',
    btnLabel: 'View Your Progress',
    action: () => switchTab('progress'),
  };
}

/* ============================================
   TAB NAVIGATION
   ============================================ */

function switchTab(tabName) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  const nav = document.querySelector(`.nav-item[data-tab="${tabName}"]`);
  const page = document.getElementById(`tab-${tabName}`);
  if (nav) nav.classList.add('active');
  if (page) page.classList.add('active');

  // Refresh data views when switching into them
  if (tabName === 'progress') renderProgressChart();
}

function initNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      switchTab(tab);
    });
  });
}

/* ============================================
   MODAL (reusable)
   ============================================ */

function openModal({ title, body, actions }) {
  document.getElementById('modal-title').textContent = title;
  const bodyEl = document.getElementById('modal-body');
  bodyEl.innerHTML = '';
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body instanceof HTMLElement) bodyEl.appendChild(body);

  const actionsEl = document.getElementById('modal-actions');
  actionsEl.innerHTML = '';
  actions.forEach(a => {
    const btn = document.createElement('button');
    btn.className = `btn ${a.variant || 'btn-secondary'}`;
    btn.textContent = a.label;
    btn.addEventListener('click', a.onClick);
    actionsEl.appendChild(btn);
  });

  document.getElementById('modal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modal').style.display = 'none';
}

/* ============================================
   PAYMENT LOGGING
   ============================================ */

function openLogPaymentModal(suggestedAmount) {
  const body = document.createElement('div');
  body.innerHTML = `
    <p style="margin-bottom: 16px;">Enter the amount you paid this week.</p>
    <div class="input-group">
      <label class="input-label" for="modal-pay-amount">Payment amount</label>
      <div class="input-prefix">
        <span class="input-prefix-symbol">$</span>
        <input
          type="number"
          id="modal-pay-amount"
          class="input"
          min="1"
          step="0.01"
          value="${suggestedAmount}"
        />
      </div>
    </div>
  `;

  openModal({
    title: 'Log Payment',
    body,
    actions: [
      { label: 'Cancel', onClick: closeModal },
      {
        label: 'Confirm Payment',
        variant: 'btn-primary',
        onClick: () => {
          const amount = parseFloat(document.getElementById('modal-pay-amount').value);
          if (!amount || amount < 0) return;
          recordPayment(amount);
          closeModal();
        },
      },
    ],
  });

  // Focus the input
  setTimeout(() => document.getElementById('modal-pay-amount')?.focus(), 80);
}

function recordPayment(amount) {
  state.payments.push({
    date: todayISO(),
    amount: Math.round(amount * 100) / 100,
  });

  // Mark week's payment as logged, and auto-check the "log payment" item
  state.currentWeek.paymentLogged = true;
  const logItem = state.currentWeek.checklist.find(c => c.id === 'c2');
  if (logItem) logItem.done = true;

  // Update milestones
  checkMilestones();

  saveState();
  renderAll();
}

/* ============================================
   MILESTONE LOGIC
   ============================================ */

function checkMilestones() {
  const paid = totalPaid();
  if (paid >= 1000) state.milestones.m1000 = true;
  if (paid >= 2500) state.milestones.m2500 = true;
  if (percentComplete() >= 50) state.milestones.m50 = true;
}

/* ============================================
   SPENDING (optional awareness)
   ============================================ */

function initSpendingForm() {
  const form = document.getElementById('spending-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = parseFloat(document.getElementById('spend-amount').value);
    const note = document.getElementById('spend-note').value.trim();
    if (!amount || amount <= 0) return;

    state.spending.unshift({
      id: `sp_${Date.now()}`,
      date: todayISO(),
      amount: Math.round(amount * 100) / 100,
      note: note || '—',
    });

    saveState();
    form.reset();
    renderSpending();
  });
}

function deleteSpending(id) {
  state.spending = state.spending.filter(s => s.id !== id);
  saveState();
  renderSpending();
}

/* ============================================
   RENDERERS
   ============================================ */

function renderAll() {
  checkWeeklyReset();
  checkMilestones();
  renderDashboard();
  renderPlan();
  renderDebt();
  renderSpending();
  renderProgress();
  renderSettings();
}

/* --- Dashboard --- */
function renderDashboard() {
  // Weekly reset banner — show only once per new week
  const banner = document.getElementById('reset-banner');
  const weekStart = state.currentWeek.weekStart;
  const announced = state.announcedWeeks.includes(weekStart);
  if (weekStart && !announced) {
    banner.style.display = 'flex';
    document.getElementById('reset-banner-text').innerHTML =
      `<strong>NEW WEEK, NEW RESET</strong> — Your goal this week: <strong>${fmtMoney(state.currentWeek.goal)}</strong>.`;
    state.announcedWeeks.push(weekStart);
    saveState();
  } else {
    banner.style.display = 'none';
  }

  // Next action
  const na = computeNextAction();
  document.getElementById('next-action-title').textContent = na.title;
  document.getElementById('next-action-subtitle').textContent = na.subtitle;
  const btn = document.getElementById('next-action-btn');
  btn.textContent = na.btnLabel;
  btn.onclick = na.action;

  // Metrics
  document.getElementById('metric-owed').textContent = fmtMoney(totalRemaining());
  document.getElementById('metric-paid').textContent = fmtMoney(totalPaid());
  document.getElementById('metric-months').textContent = monthsRemaining();

  // Progress bar
  const pct = percentComplete();
  document.getElementById('progress-percent').textContent = pct + '%';
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-paid-sub').textContent = `${fmtMoney(totalPaid())} paid`;
  document.getElementById('progress-total-sub').textContent = `of ${fmtMoney(state.setup.totalDebt)}`;
}

/* --- Plan --- */
function renderPlan() {
  const goal = state.currentWeek.goal;

  // Focus card
  document.getElementById('plan-focus-title').textContent =
    `Your focus this week: ${fmtMoney(goal)}`;

  // Log payment button
  const logBtn = document.getElementById('plan-log-btn');
  if (state.currentWeek.paymentLogged) {
    logBtn.textContent = 'Payment Logged ✓';
    logBtn.disabled = true;
    logBtn.style.opacity = '0.55';
    logBtn.style.cursor = 'default';
  } else {
    logBtn.textContent = `LOG THIS WEEK'S PAYMENT`;
    logBtn.disabled = false;
    logBtn.style.opacity = '1';
    logBtn.style.cursor = 'pointer';
    logBtn.onclick = () => openLogPaymentModal(goal);
  }

  // Breakdown — simple 3-part split across the week
  const breakdown = document.getElementById('plan-breakdown');
  breakdown.innerHTML = '';
  const split = [
    { day: 'Early week', amount: Math.round(goal * 0.2) },
    { day: 'Mid week',   amount: Math.round(goal * 0.2) },
    { day: 'Late week',  amount: goal - Math.round(goal * 0.2) * 2 },
  ];
  split.forEach(s => {
    const row = document.createElement('div');
    row.className = 'breakdown-item';
    row.innerHTML = `
      <span class="breakdown-day">${s.day}</span>
      <span class="breakdown-amount">${fmtMoney(s.amount)}</span>
    `;
    breakdown.appendChild(row);
  });

  // Checklist
  const checklist = document.getElementById('plan-checklist');
  checklist.innerHTML = '';
  state.currentWeek.checklist.forEach(c => {
    const item = document.createElement('div');
    item.className = 'checklist-item' + (c.done ? ' done' : '');
    item.innerHTML = `
      <div class="checkbox"></div>
      <div class="checklist-label">${c.item}</div>
    `;
    item.addEventListener('click', () => {
      c.done = !c.done;
      saveState();
      renderAll();
    });
    checklist.appendChild(item);
  });

  // Next week preview
  document.getElementById('plan-next-week').textContent = fmtMoney(weeklyGoal());
}

/* --- Debt --- */
function renderDebt() {
  const remaining = totalRemaining();
  const paid = totalPaid();

  document.getElementById('debt-remaining-value').textContent = fmtMoney(remaining);

  const sub = document.getElementById('debt-remaining-sub');
  if (paid > 0) {
    sub.textContent = `You've already paid ${fmtMoney(paid)}. Here's what's left.`;
  } else {
    sub.textContent = "This is what remains.";
  }

  // Debt list
  const list = document.getElementById('debt-list');
  list.innerHTML = '';
  const sources = state.setup.debtSources || [];

  if (sources.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        You haven't added individual debts.<br>
        Add them in Settings if you'd like to track them separately.
      </div>
    `;
    return;
  }

  // Distribute total paid proportionally across debts (for display only).
  // This is a simple approximation — users aren't expected to track per-debt here.
  const totalDeclared = sources.reduce((a, s) => a + s.amount, 0) || 1;
  sources.forEach(src => {
    const estPaid = Math.min(src.amount, Math.round((src.amount / totalDeclared) * paid));
    const estRemaining = Math.max(0, src.amount - estPaid);
    const pct = Math.min(100, Math.round((estPaid / src.amount) * 100));

    const item = document.createElement('div');
    item.className = 'debt-item';
    item.innerHTML = `
      <div class="debt-item-header">
        <span class="debt-item-name">${escapeHtml(src.name)}</span>
        <span class="debt-item-amount">
          <strong>${fmtMoney(estRemaining)}</strong> remaining · ${fmtMoney(estPaid)} paid
        </span>
      </div>
      <div class="progress-track" style="height: 6px;">
        <div class="progress-fill" style="width: ${pct}%;"></div>
      </div>
    `;
    list.appendChild(item);
  });
}

/* --- Spending --- */
function renderSpending() {
  const entries = document.getElementById('spending-entries');
  entries.innerHTML = '';

  if (state.spending.length === 0) {
    entries.innerHTML = '<div class="spending-empty">No entries yet. Log one above if you\'d like.</div>';
  } else {
    // Show most recent 15
    state.spending.slice(0, 15).forEach(s => {
      const item = document.createElement('div');
      item.className = 'spending-item';
      item.innerHTML = `
        <span class="spending-date">${fmtShortDate(s.date)}</span>
        <span class="spending-amount">${fmtMoney(s.amount)}</span>
        <span class="spending-note">${escapeHtml(s.note)}</span>
      `;
      const del = document.createElement('button');
      del.className = 'spending-delete';
      del.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>`;
      del.addEventListener('click', () => deleteSpending(s.id));
      item.appendChild(del);
      entries.appendChild(item);
    });
  }

  // Totals — awareness only, NO targets / warnings / judgments
  const today = todayISO();
  const weekStart = weekStartISO();
  const todayTotal = state.spending
    .filter(s => s.date === today)
    .reduce((a, s) => a + s.amount, 0);
  const weekTotal = state.spending
    .filter(s => s.date >= weekStart)
    .reduce((a, s) => a + s.amount, 0);

  document.getElementById('spend-today').textContent = fmtMoney(todayTotal);
  document.getElementById('spend-week').textContent = fmtMoney(weekTotal);
}

/* --- Progress --- */
function renderProgress() {
  const pct = percentComplete();
  document.getElementById('progress-hero-percent').textContent = pct + '%';

  // Milestones — unlock styling
  document.getElementById('milestone-1000').classList.toggle('unlocked', state.milestones.m1000);
  document.getElementById('milestone-2500').classList.toggle('unlocked', state.milestones.m2500);
  document.getElementById('milestone-50').classList.toggle('unlocked', state.milestones.m50);

  // Paid vs remaining
  document.getElementById('split-paid').textContent = fmtMoney(totalPaid());
  document.getElementById('split-remaining').textContent = fmtMoney(totalRemaining());

  // Chart only renders if tab is active — called in switchTab as well
  if (document.getElementById('tab-progress').classList.contains('active')) {
    renderProgressChart();
  }
}

/* ============================================
   PROGRESS CHART — Pure SVG, no external library
   ============================================

   Renders a minimal line chart showing debt remaining over time.
   Starts at totalDebt, drops at each payment.
   If no payments yet, shows a single projected point to avoid emptiness.
   ============================================ */

function renderProgressChart() {
  const container = document.getElementById('payoff-chart');
  if (!container) return;

  const startDebt = state.setup.totalDebt;
  if (!startDebt) {
    container.innerHTML = '';
    return;
  }

  // Build chronological data series: [start, after each payment]
  const payments = [...state.payments].sort((a, b) => a.date.localeCompare(b.date));
  const labels = ['Start'];
  const values = [startDebt];
  let running = startDebt;
  payments.forEach(p => {
    running = Math.max(0, running - p.amount);
    labels.push(fmtShortDate(p.date));
    values.push(running);
  });

  // If no payments yet, add a "next" projection point so the chart isn't a single dot
  if (payments.length === 0) {
    labels.push('Next');
    values.push(Math.max(0, startDebt - state.setup.monthlyPayment));
  }

  // Chart dimensions (SVG viewBox — scales responsively to container width)
  const W = 640;
  const H = 260;
  const padL = 56;  // left padding for y-axis labels
  const padR = 20;
  const padT = 20;
  const padB = 36;  // bottom padding for x-axis labels
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxY = Math.max(...values, 1);
  const minY = 0;

  // Scale functions
  const scaleX = (i) => padL + (values.length === 1 ? plotW / 2 : (plotW * i) / (values.length - 1));
  const scaleY = (v) => padT + plotH - ((v - minY) / (maxY - minY || 1)) * plotH;

  // Build line path
  const linePoints = values.map((v, i) => `${scaleX(i)},${scaleY(v)}`).join(' ');
  const areaPath = `M ${scaleX(0)},${scaleY(minY)} L ${linePoints.split(' ').join(' L ')} L ${scaleX(values.length - 1)},${scaleY(minY)} Z`;
  const linePath = `M ${linePoints.split(' ').join(' L ')}`;

  // Y-axis ticks (4 values: 0, 1/3, 2/3, max)
  const yTicks = [0, maxY * 0.33, maxY * 0.66, maxY].map(v => Math.round(v));

  // Build SVG
  const gridLines = yTicks.map(v => {
    const y = scaleY(v);
    return `<line class="chart-grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" />`;
  }).join('');

  const yLabels = yTicks.map(v => {
    const y = scaleY(v);
    return `<text class="chart-axis-label" x="${padL - 8}" y="${y + 4}" text-anchor="end">${fmtMoney(v)}</text>`;
  }).join('');

  // X-axis labels — show first, last, and a middle label if there are enough points
  const xLabelIndices = new Set([0, values.length - 1]);
  if (values.length >= 5) xLabelIndices.add(Math.floor(values.length / 2));
  const xLabels = [...xLabelIndices].map(i => {
    const x = scaleX(i);
    const anchor = i === 0 ? 'start' : (i === values.length - 1 ? 'end' : 'middle');
    return `<text class="chart-axis-label" x="${x}" y="${H - 12}" text-anchor="${anchor}">${labels[i]}</text>`;
  }).join('');

  // Data points — small circles at each payment
  const points = values.map((v, i) =>
    `<circle class="chart-point" cx="${scaleX(i)}" cy="${scaleY(v)}" r="3.5" />`
  ).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Payoff timeline">
      ${gridLines}
      ${yLabels}
      <path class="chart-area" d="${areaPath}" />
      <path class="chart-line" d="${linePath}" />
      ${points}
      ${xLabels}
    </svg>
  `;
}

/* --- Settings --- */
function renderSettings() {
  document.getElementById('settings-monthly').value = state.setup.monthlyPayment || '';
  document.getElementById('settings-debt').value = state.setup.totalDebt || '';

  // Debt sources editor
  const list = document.getElementById('settings-sources-list');
  list.innerHTML = '';
  (state.setup.debtSources || []).forEach((src, idx) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.style.marginTop = '8px';
    row.innerHTML = `
      <div class="input-group" style="flex: 2;">
        <input type="text" class="input" data-role="name" value="${escapeHtml(src.name)}" placeholder="Debt name" />
      </div>
      <div class="input-group" style="flex: 1;">
        <div class="input-prefix">
          <span class="input-prefix-symbol">$</span>
          <input type="number" class="input" data-role="amount" value="${src.amount}" min="0" step="1" />
        </div>
      </div>
    `;
    const del = document.createElement('button');
    del.className = 'btn btn-danger';
    del.textContent = '×';
    del.style.padding = '12px 16px';
    del.addEventListener('click', () => {
      state.setup.debtSources.splice(idx, 1);
      saveState();
      renderSettings();
      renderDebt();
    });
    row.appendChild(del);

    // Auto-save on change
    row.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('change', () => {
        const name = row.querySelector('[data-role="name"]').value.trim() || `Debt ${idx + 1}`;
        const amount = parseFloat(row.querySelector('[data-role="amount"]').value) || 0;
        state.setup.debtSources[idx].name = name;
        state.setup.debtSources[idx].amount = amount;
        saveState();
        renderDebt();
      });
    });

    list.appendChild(row);
  });
}

/* ============================================
   SETTINGS ACTIONS
   ============================================ */

function initSettingsActions() {
  // Update monthly payment
  document.getElementById('update-monthly-btn').addEventListener('click', () => {
    const val = parseFloat(document.getElementById('settings-monthly').value);
    if (!val || val < 1) return;
    state.setup.monthlyPayment = val;
    state.currentWeek.goal = weeklyGoal(); // recalc weekly goal
    saveState();
    renderAll();
  });

  // Update total debt
  document.getElementById('update-debt-btn').addEventListener('click', () => {
    const val = parseFloat(document.getElementById('settings-debt').value);
    if (!val || val < 1) return;
    state.setup.totalDebt = val;
    saveState();
    renderAll();
  });

  // Add a new debt source
  document.getElementById('add-source-btn').addEventListener('click', () => {
    const idx = state.setup.debtSources.length;
    state.setup.debtSources.push({
      id: `src_${Date.now()}`,
      name: `Debt ${idx + 1}`,
      amount: 0,
      paid: 0,
    });
    saveState();
    renderSettings();
    renderDebt();
  });

  // Reset everything
  document.getElementById('reset-btn').addEventListener('click', () => {
    openModal({
      title: 'Reset Everything?',
      body: 'This will clear all your data — debts, payments, spending, and progress. This action cannot be undone.',
      actions: [
        { label: 'Cancel', onClick: closeModal },
        {
          label: 'Yes, Reset',
          variant: 'btn-danger',
          onClick: () => {
            localStorage.removeItem(STORAGE_KEY);
            state = structuredClone(DEFAULT_STATE);
            closeModal();
            showSetup();
          },
        },
      ],
    });
  });
}

/* ============================================
   SAFETY HELPERS
   ============================================ */

// Basic HTML-escape for user-generated strings rendered into innerHTML
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ============================================
   BOOT
   ============================================ */

function init() {
  initSetupForm();
  initNavigation();
  initSpendingForm();
  initSettingsActions();

  // Decide initial screen
  if (!state.setup.totalDebt || !state.setup.monthlyPayment) {
    showSetup();
  } else {
    // Ensure a current week exists
    if (!state.currentWeek.weekStart) {
      initializeNewWeek();
      saveState();
    }
    showApp();
  }
}

// Start the app
document.addEventListener('DOMContentLoaded', init);
