import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import {
  LayoutDashboard, ScanLine, ReceiptText, ChevronDown, ChevronUp,
  Pencil, Check, X, Plus, ArrowUp, ArrowDown, Minus, Trash2,
  ImagePlus, Loader2, Tag, Search, KeyRound, Save, CheckCircle2,
} from 'lucide-react';

/* ============================== CONSTANTS ============================== */

const COLORS = {
  cream: '#F6F1E6',
  navy: '#2E3A59',
  aldi: '#B04A14',
  woolies: '#1B6B3A',
  card: '#FFFFFF',
  field: '#FCFAF5',
  border: 'rgba(46,58,89,0.14)',
  muted: '#5A6380',
  priceUp: '#C03535',
  priceDown: '#1F7A34',
};

const STORES = ['Aldi', 'Woolworths'];

const LS_KEYS = {
  RECEIPTS: 'grt_receipts_v1',
  KNOWN_ITEMS: 'grt_known_items_v1',
  API_KEY: 'grt_claude_api_key_v1',
};

// Sonnet is the most accurate on faded/abbreviated receipts; swap to 'claude-haiku-5-5' for cheaper scans.
const CLAUDE_MODEL = 'claude-sonnet-5-5';

/* ============================== UTILS ============================== */

let _uidCounter = 0;
function uid() {
  _uidCounter += 1;
  return `${Date.now().toString(36)}_${_uidCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatAUD(amount) {
  const n = Number(amount);
  if (Number.isNaN(n)) return '$0.00';
  return `$${n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Accepts 'YYYY-MM-DD' ISO string or a Date/number(ms) and returns 'dd/mm/yyyy'
function formatDateAU(input) {
  let d;
  if (input instanceof Date) d = input;
  else if (typeof input === 'number') d = new Date(input);
  else if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}/.test(input)) {
    const [y, m, day] = input.split('-').map((x) => parseInt(x, 10));
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(input);
  }
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function isoFromParts(day, month, year) {
  let y = year;
  if (String(year).length === 2) y = 2000 + parseInt(year, 10);
  const m = pad2(month);
  const d = pad2(day);
  return `${y}-${m}-${d}`;
}

function normKey(name) {
  return String(name || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

/* ============================== STORAGE ============================== */

function getReceipts() {
  try {
    const raw = localStorage.getItem(LS_KEYS.RECEIPTS);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}
function setReceipts(receipts) {
  localStorage.setItem(LS_KEYS.RECEIPTS, JSON.stringify(receipts));
}
function getKnownItems() {
  try {
    const raw = localStorage.getItem(LS_KEYS.KNOWN_ITEMS);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}
function setKnownItems(items) {
  localStorage.setItem(LS_KEYS.KNOWN_ITEMS, JSON.stringify(items));
}
function getApiKey() {
  return localStorage.getItem(LS_KEYS.API_KEY) || '';
}
function setApiKey(key) {
  localStorage.setItem(LS_KEYS.API_KEY, key || '');
}

/* ============================== IMAGE RESIZE ============================== */

function resizeImageFile(file, maxDim = 1400) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
        else { width = Math.round((width * maxDim) / height); height = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

/* ============================== CLAUDE RECEIPT READER ============================== */

const RECEIPT_TOOL = {
  name: 'record_receipt',
  description: 'Record the structured contents of a grocery receipt.',
  input_schema: {
    type: 'object',
    properties: {
      store: { type: 'string', enum: ['Aldi', 'Woolworths', 'Unknown'], description: 'Which supermarket issued the receipt.' },
      date: { type: 'string', description: 'Purchase date as YYYY-MM-DD. Australian receipts print dates as DD/MM/YY(YY). Empty string if not visible.' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Product name as printed, with abbreviations expanded only when obvious.' },
            qty: { type: 'number', description: 'Quantity bought (or weight in kg for priced-by-weight items).' },
            unitPrice: { type: 'number', description: 'Price per unit (or per kg) in AUD, after any line discount shown directly under the item.' },
          },
          required: ['name', 'qty', 'unitPrice'],
        },
      },
      gst: { type: ['number', 'null'], description: 'GST amount in AUD if printed, otherwise null.' },
      total: { type: ['number', 'null'], description: 'Final amount paid in AUD, otherwise null.' },
    },
    required: ['store', 'date', 'items', 'gst', 'total'],
  },
};

const RECEIPT_PROMPT = `Read this Australian supermarket receipt and record it with the record_receipt tool.
- Include every purchased product line. Skip payment, card, loyalty/rewards, savings summary, rounding and subtotal lines.
- If a line shows a quantity (e.g. "2 @ $1.50" or "3 x"), set qty and unitPrice accordingly.
- For weighed items (e.g. "0.512 kg @ $4.99/kg"), qty is the weight and unitPrice the per-kg price.
- If a discount or price reduction is printed directly beneath an item, fold it into that item's unitPrice.
- Use plain numbers for money (no $ sign).`;

async function callClaude(base64DataUrl, apiKey) {
  const [header, data] = base64DataUrl.split(',');
  const mediaType = (header.match(/data:(.*?);base64/) || [])[1] || 'image/jpeg';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      tools: [RECEIPT_TOOL],
      tool_choice: { type: 'tool', name: RECEIPT_TOOL.name },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          { type: 'text', text: RECEIPT_PROMPT },
        ],
      }],
    }),
  });

  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON error */ }
  if (!res.ok) {
    const msg = body && body.error && body.error.message;
    if (res.status === 401) throw new Error('Claude rejected the API key — check it and try again.');
    if (res.status === 429) throw new Error('Rate limited by Claude — wait a moment and try again.');
    throw new Error(msg ? `Claude error: ${msg}` : `Claude request failed (${res.status})`);
  }

  const toolUse = (body.content || []).find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error("Claude couldn't read that receipt — try a clearer photo.");
  const r = toolUse.input || {};

  const items = (Array.isArray(r.items) ? r.items : [])
    .filter((it) => it && String(it.name || '').trim())
    .map((it) => ({
      id: uid(),
      name: String(it.name).trim(),
      qty: Number(it.qty) > 0 ? Number(it.qty) : 1,
      unitPrice: Math.round((Number(it.unitPrice) || 0) * 100) / 100,
    }));

  return {
    store: STORES.includes(r.store) ? r.store : null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : null,
    gst: typeof r.gst === 'number' ? r.gst : null,
    total: typeof r.total === 'number' ? r.total : null,
    items,
    rawText: JSON.stringify(r),
  };
}

/* ============================== SHARED STYLES ============================== */

const S = {
  card: {
    background: COLORS.card,
    borderRadius: 18,
    padding: 16,
    boxShadow: '0 1px 4px rgba(46,58,89,0.06)',
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: COLORS.navy,
    margin: '0 0 10px 0',
  },
  rowButton: {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 52,
    padding: '8px 2px', background: 'transparent', border: 'none',
    borderBottom: '1px solid rgba(46,58,89,0.10)', cursor: 'pointer', textAlign: 'left',
    color: '#2E3A59', fontSize: 15.5, fontFamily: "'Space Grotesk', system-ui, sans-serif",
  },
  input: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 16,
    padding: '11px 12px',
    borderRadius: 10,
    border: `1px solid ${COLORS.border}`,
    background: COLORS.field,
    color: COLORS.navy,
    outline: 'none',
    width: '100%',
  },
  textInput: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 16,
    padding: '11px 12px',
    borderRadius: 10,
    border: `1px solid ${COLORS.border}`,
    background: COLORS.field,
    color: COLORS.navy,
    outline: 'none',
    width: '100%',
  },
  button: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontWeight: 600,
    fontSize: 15,
    padding: '12px 16px',
    minHeight: 44,
    borderRadius: 12,
    border: 'none',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
};

function PrimaryButton({ children, onClick, style, disabled, type = 'button' }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        ...S.button,
        background: disabled ? '#B7BECF' : COLORS.navy,
        color: '#fff',
        opacity: disabled ? 0.7 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function GhostButton({ children, onClick, style, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...S.button,
        background: 'transparent',
        color: COLORS.navy,
        border: `1px solid ${COLORS.border}`,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/* ============================== TOAST ============================== */

function Toast({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => onDismiss(), 4200);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

  if (!toast) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
        left: 12,
        right: 12,
        zIndex: 999,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          background: COLORS.navy,
          color: '#fff',
          borderRadius: 14,
          padding: '6px 8px 6px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          boxShadow: '0 8px 24px rgba(46,58,89,0.35)',
          maxWidth: 460,
          width: '100%',
        }}
      >
        <CheckCircle2 size={20} style={{ flexShrink: 0 }} aria-hidden="true" />
        <div role="status" style={{ fontSize: 15, fontWeight: 500, lineHeight: 1.4 }}>{toast.message}</div>
        <IconButton label="Dismiss" onClick={onDismiss} style={{ marginLeft: 'auto', marginRight: -8 }}><X size={18} color="#fff" /></IconButton>
      </div>
    </div>
  );
}

/* ============================== SUMMARY / SMALL PIECES ============================== */

function storeColor(store) {
  return store === 'Aldi' ? COLORS.aldi : store === 'Woolworths' ? COLORS.woolies : COLORS.navy;
}

function StoreDot({ store, size = 9 }) {
  return <span aria-hidden="true" style={{ display: 'inline-block', flexShrink: 0, width: size, height: size, borderRadius: '50%', background: storeColor(store), marginRight: 7 }} />;
}

function PriceChangeIndicator({ direction }) {
  if (direction === 'up') return <ArrowUp size={15} color={COLORS.priceUp} aria-label="Price went up" />;
  if (direction === 'down') return <ArrowDown size={15} color={COLORS.priceDown} aria-label="Price went down" />;
  return <Minus size={14} color={COLORS.muted} aria-label="No change" style={{ opacity: 0.6 }} />;
}

function SectionTitle({ children, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: COLORS.navy }}>{children}</h2>
      {right}
    </div>
  );
}

function Segmented({ options, value, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'flex', background: 'rgba(46,58,89,0.07)', borderRadius: 12, padding: 3, gap: 3 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            style={{
              ...S.button, flex: 1, justifyContent: 'center', minHeight: 40, padding: '8px 6px', fontSize: 14,
              background: on ? '#fff' : 'transparent',
              color: on ? (o.accent || COLORS.navy) : COLORS.muted,
              boxShadow: on ? '0 1px 3px rgba(46,58,89,0.15)' : 'none',
              borderRadius: 10,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ============================== DERIVED DATA HELPERS ============================== */

function dateFromIso(iso) {
  const [y, m, d] = String(iso).split('-').map((x) => parseInt(x, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}
function isoFromDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Returns { start, end, prevStart, prevEnd, title, prevLabel } as ISO strings (end exclusive).
// The previous range covers the same number of days so far, for a fair comparison.
function periodRange(period, today = new Date()) {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const tomorrow = new Date(t); tomorrow.setDate(t.getDate() + 1);
  if (period === 'week') {
    const dow = (t.getDay() + 6) % 7; // Monday = 0
    const start = new Date(t); start.setDate(t.getDate() - dow);
    const prevStart = new Date(start); prevStart.setDate(start.getDate() - 7);
    const prevEnd = new Date(tomorrow); prevEnd.setDate(tomorrow.getDate() - 7);
    return { start: isoFromDate(start), end: isoFromDate(tomorrow), prevStart: isoFromDate(prevStart), prevEnd: isoFromDate(prevEnd), title: 'Spent this week', prevLabel: 'this time last week' };
  }
  if (period === 'month') {
    const start = new Date(t.getFullYear(), t.getMonth(), 1);
    const prevStart = new Date(t.getFullYear(), t.getMonth() - 1, 1);
    const prevMonthDays = new Date(t.getFullYear(), t.getMonth(), 0).getDate();
    const prevEnd = new Date(t.getFullYear(), t.getMonth() - 1, Math.min(t.getDate(), prevMonthDays) + 1);
    return { start: isoFromDate(start), end: isoFromDate(tomorrow), prevStart: isoFromDate(prevStart), prevEnd: isoFromDate(prevEnd), title: `Spent in ${MONTHS[t.getMonth()]}`, prevLabel: `this time in ${MONTHS[prevStart.getMonth()]}` };
  }
  return { start: null, end: null, prevStart: null, prevEnd: null, title: 'Spent all time', prevLabel: null };
}

function inRange(r, start, end) {
  if (!start) return true;
  return r.date >= start && r.date < end;
}

function computeAggregates(receipts) {
  let totalSpend = 0, aldiSpend = 0, wooliesSpend = 0, aldiTrips = 0, wooliesTrips = 0, totalGst = 0;
  for (const r of receipts) {
    const total = Number(r.total) || 0;
    totalSpend += total;
    totalGst += Number(r.gst) || 0;
    if (r.store === 'Aldi') { aldiSpend += total; aldiTrips += 1; }
    else if (r.store === 'Woolworths') { wooliesSpend += total; wooliesTrips += 1; }
  }
  return { totalSpend, aldiSpend, wooliesSpend, aldiTrips, wooliesTrips, totalGst };
}

// Every occurrence of every item, sorted chronologically, grouped by normalized name.
function buildItemHistory(receipts) {
  const groups = new Map();
  const sorted = [...receipts].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const r of sorted) {
    for (const it of (r.items || [])) {
      const key = normKey(it.name);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { name: it.name, occurrences: [] });
      groups.get(key).occurrences.push({
        date: r.date, unitPrice: Number(it.unitPrice) || 0, qty: Number(it.qty) || 0,
        store: r.store, receiptId: r.id,
      });
    }
  }
  return groups;
}

function itemHistoryRows(receipts) {
  const rows = [];
  for (const [key, g] of buildItemHistory(receipts).entries()) {
    const occ = g.occurrences;
    const last = occ[occ.length - 1];
    const prev = occ.length > 1 ? occ[occ.length - 2] : null;
    let direction = 'flat';
    let change = 0;
    if (prev) {
      change = last.unitPrice - prev.unitPrice;
      if (change > 0.004) direction = 'up';
      else if (change < -0.004) direction = 'down';
    }
    rows.push({
      key, name: g.name, timesBought: occ.length, lastPrice: last.unitPrice,
      prevPrice: prev ? prev.unitPrice : null, change,
      changePct: prev && prev.unitPrice > 0 ? change / prev.unitPrice : 0,
      lastDate: last.date, lastStore: last.store, direction,
    });
  }
  rows.sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : a.name.localeCompare(b.name)));
  return rows;
}

function shortDate(iso) {
  const d = dateFromIso(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}

/* ============================== CHART BITS ============================== */

function StoreColoredDot(props) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null) return null;
  return <circle cx={cx} cy={cy} r={5} fill={storeColor(payload && payload.store)} stroke="#fff" strokeWidth={1.5} />;
}

function ChartTooltipContent({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{ background: COLORS.navy, color: '#fff', padding: '8px 12px', borderRadius: 10, fontSize: 14 }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600 }}>{formatAUD(p.y)}</div>
      <div style={{ opacity: 0.9, fontSize: 13, marginTop: 2 }}>{p.store || 'Unknown'}, {formatDateAU(p.date)}</div>
    </div>
  );
}

function ChartLegend() {
  return (
    <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 14, color: COLORS.muted }}>
      <span style={{ display: 'inline-flex', alignItems: 'center' }}><StoreDot store="Aldi" />Aldi</span>
      <span style={{ display: 'inline-flex', alignItems: 'center' }}><StoreDot store="Woolworths" />Woolworths</span>
    </div>
  );
}

/* ============================== HERO DOCKET ============================== */

// The month/week total, set like the total line of a printed docket with a torn bottom edge.
function SpendDocket({ range, agg, prevTotal, receiptCount }) {
  const total = agg.totalSpend;
  const aldiPct = total > 0 ? (agg.aldiSpend / total) * 100 : 0;
  const diff = prevTotal != null ? total - prevTotal : null;
  return (
    <div style={{ position: 'relative', filter: 'drop-shadow(0 3px 8px rgba(46,58,89,0.10))' }}>
      <div style={{ background: '#fff', borderRadius: '18px 18px 0 0', padding: '18px 18px 20px' }}>
        <div style={{ fontSize: 15, color: COLORS.muted, fontWeight: 500 }}>{range.title}</div>
        <div className="mono" style={{ fontSize: 44, fontWeight: 600, lineHeight: 1.1, color: COLORS.navy, margin: '4px 0 6px', letterSpacing: -1 }}>
          {formatAUD(total)}
        </div>
        <div style={{ fontSize: 14, color: COLORS.muted, minHeight: 20 }}>
          {diff == null
            ? `${receiptCount} receipt${receiptCount === 1 ? '' : 's'}`
            : prevTotal === 0 && total === 0
              ? 'Nothing scanned yet'
              : (
                <span>
                  <span style={{ color: diff > 0 ? COLORS.priceUp : COLORS.priceDown, fontWeight: 600 }}>
                    {diff > 0 ? '+' : diff < 0 ? '−' : ''}{formatAUD(Math.abs(diff))}
                  </span>
                  {' '}vs {range.prevLabel}
                </span>
              )}
        </div>

        <div aria-hidden="true" style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', background: 'rgba(46,58,89,0.08)', margin: '16px 0 12px' }}>
          {total > 0 && <div style={{ width: `${aldiPct}%`, background: COLORS.aldi }} />}
          {total > 0 && <div style={{ width: `${100 - aldiPct}%`, background: COLORS.woolies }} />}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[['Aldi', agg.aldiSpend, agg.aldiTrips], ['Woolworths', agg.wooliesSpend, agg.wooliesTrips]].map(([s, amt, trips]) => (
            <div key={s}>
              <div style={{ display: 'flex', alignItems: 'center', fontSize: 14, color: COLORS.muted }}><StoreDot store={s} />{s}</div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 600, color: storeColor(s), marginTop: 2 }}>{formatAUD(amt)}</div>
              <div style={{ fontSize: 13, color: COLORS.muted }}>{trips} trip{trips === 1 ? '' : 's'}</div>
            </div>
          ))}
        </div>
      </div>
      <svg aria-hidden="true" width="100%" height="10" preserveAspectRatio="none" viewBox="0 0 100 10" style={{ display: 'block' }}>
        <path d={'M0 0 ' + Array.from({ length: 25 }, (_, i) => `L${i * 4 + 2} 9 L${i * 4 + 4} 0`).join(' ') + ' Z'} fill="#fff" />
      </svg>
    </div>
  );
}

/* ============================== ITEM DETAIL SHEET ============================== */

function ItemDetailSheet({ name, receipts, onClose }) {
  const points = useMemo(() => {
    const key = normKey(name);
    const out = [];
    for (const r of receipts) {
      for (const it of (r.items || [])) {
        if (normKey(it.name) === key && r.date) {
          out.push({ x: dateFromIso(r.date).getTime(), y: Number(it.unitPrice) || 0, store: r.store, date: r.date });
        }
      }
    }
    return out.sort((a, b) => a.x - b.x);
  }, [name, receipts]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const prices = points.map((p) => p.y);
  const low = prices.length ? Math.min(...prices) : 0;
  const high = prices.length ? Math.max(...prices) : 0;
  const lowPoint = points.find((p) => p.y === low);

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={`${name} price history`} style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'flex-end', background: 'rgba(30,38,58,0.45)' }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLORS.cream, width: '100%', maxWidth: 640, margin: '0 auto', borderRadius: '22px 22px 0 0',
          padding: '18px 16px calc(env(safe-area-inset-bottom, 0px) + 20px)', maxHeight: '85vh', overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 21, fontWeight: 700, flex: 1, lineHeight: 1.25 }}>{name}</h2>
          <IconButton label="Close" onClick={onClose}><X size={20} color={COLORS.navy} /></IconButton>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
          {[['Latest', prices[prices.length - 1] || 0], ['Lowest', low], ['Highest', high]].map(([l, v]) => (
            <div key={l} style={{ ...S.card, padding: 12 }}>
              <div style={{ fontSize: 13, color: COLORS.muted }}>{l}</div>
              <div className="mono" style={{ fontSize: 17, fontWeight: 600, marginTop: 2 }}>{formatAUD(v)}</div>
            </div>
          ))}
        </div>

        <div style={S.card}>
          {points.length < 2 ? (
            <div style={{ padding: '28px 0', textAlign: 'center', color: COLORS.muted, fontSize: 15 }}>
              Bought once so far. Scan more receipts to see how the price changes.
            </div>
          ) : (
            <>
              <div style={{ width: '100%', height: 220 }}>
                <ResponsiveContainer>
                  <LineChart data={points} margin={{ top: 8, right: 12, left: -14, bottom: 0 }}>
                    <CartesianGrid stroke={COLORS.border} vertical={false} />
                    <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(v) => shortDate(isoFromDate(new Date(v)))} tick={{ fontSize: 12, fill: COLORS.muted }} axisLine={{ stroke: COLORS.border }} tickLine={false} minTickGap={24} />
                    <YAxis tickFormatter={(v) => `$${v}`} tick={{ fontSize: 12, fill: COLORS.muted }} axisLine={false} tickLine={false} width={50} domain={['auto', 'auto']} />
                    <Tooltip content={<ChartTooltipContent />} />
                    <Line type="linear" dataKey="y" stroke="rgba(46,58,89,0.35)" strokeWidth={2} dot={<StoreColoredDot />} activeDot={{ r: 7 }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <ChartLegend />
            </>
          )}
        </div>

        {lowPoint && points.length > 1 && (
          <p style={{ fontSize: 15, color: COLORS.muted, margin: '12px 4px 0', lineHeight: 1.5 }}>
            Cheapest was {formatAUD(low)} at {lowPoint.store} on {formatDateAU(lowPoint.date)}. Bought {points.length} times.
          </p>
        )}
      </div>
    </div>,
    document.body
  );
}

function IconButton({ label, onClick, children, style }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{ minWidth: 44, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', borderRadius: 10, cursor: 'pointer', padding: 0, flexShrink: 0, ...style }}
    >
      {children}
    </button>
  );
}

/* ============================== MANAGE ITEM NAMES PANEL ============================== */

function ManageItemsPanel({ knownItems, onRename }) {
  const [open, setOpen] = useState(false);
  const [editingKey, setEditingKey] = useState(null);
  const [draft, setDraft] = useState('');

  const sorted = useMemo(() => [...knownItems].sort((a, b) => a.localeCompare(b)), [knownItems]);

  function startEdit(name) { setEditingKey(normKey(name)); setDraft(name); }
  function commitEdit(oldName) {
    const newName = draft.trim();
    setEditingKey(null);
    if (!newName || normKey(newName) === normKey(oldName)) return;
    onRename(oldName, newName);
  }

  return (
    <div style={S.card}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ background: 'transparent', border: 'none', width: '100%', minHeight: 44, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: COLORS.navy }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Tag size={18} />
          <span style={{ fontWeight: 600, fontSize: 16 }}>Rename items</span>
          <span style={{ fontSize: 14, color: COLORS.muted }}>{knownItems.length}</span>
        </span>
        {open ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
      </button>
      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 360, overflowY: 'auto' }}>
          <p style={{ fontSize: 14, color: COLORS.muted, margin: '0 0 6px', lineHeight: 1.45 }}>
            Give an item the same name as another to merge their price history.
          </p>
          {sorted.length === 0 && <div style={{ fontSize: 15, color: COLORS.muted, padding: '8px 0' }}>No items scanned yet.</div>}
          {sorted.map((name) => {
            const isEditing = editingKey === normKey(name);
            return (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px 2px 12px', borderRadius: 10, background: COLORS.field, border: `1px solid ${COLORS.border}` }}>
                {isEditing ? (
                  <>
                    <input
                      autoFocus value={draft} aria-label={`New name for ${name}`}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(name); if (e.key === 'Escape') setEditingKey(null); }}
                      style={{ ...S.textInput, padding: '8px 10px' }}
                    />
                    <IconButton label="Save name" onClick={() => commitEdit(name)}><Check size={18} color={COLORS.priceDown} /></IconButton>
                    <IconButton label="Cancel" onClick={() => setEditingKey(null)}><X size={18} color={COLORS.muted} /></IconButton>
                  </>
                ) : (
                  <>
                    <span style={{ flex: 1, fontSize: 15 }}>{name}</span>
                    <IconButton label={`Rename ${name}`} onClick={() => startEdit(name)}><Pencil size={16} color={COLORS.muted} /></IconButton>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================== DASHBOARD TAB ============================== */

function DashboardTab({ receipts, knownItems, onRenameItem, onScan }) {
  const [period, setPeriod] = useState('month');
  const [itemQuery, setItemQuery] = useState('');
  const [openItem, setOpenItem] = useState(null);

  const range = useMemo(() => periodRange(period), [period]);
  const periodReceipts = useMemo(() => receipts.filter((r) => inRange(r, range.start, range.end)), [receipts, range]);
  const agg = useMemo(() => computeAggregates(periodReceipts), [periodReceipts]);
  const prevTotal = useMemo(() => {
    if (!range.prevStart) return null;
    return receipts.filter((r) => inRange(r, range.prevStart, range.prevEnd)).reduce((s, r) => s + (Number(r.total) || 0), 0);
  }, [receipts, range]);

  const tripData = useMemo(() => [...periodReceipts]
    .filter((r) => r.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((r) => ({ id: r.id, label: shortDate(r.date), y: Number(r.total) || 0, store: r.store, date: r.date })), [periodReceipts]);

  const allRows = useMemo(() => itemHistoryRows(receipts), [receipts]);
  const risers = useMemo(() => allRows
    .filter((r) => r.direction === 'up' && inRange({ date: r.lastDate }, range.start, range.end))
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 5), [allRows, range]);
  const shownRows = useMemo(() => {
    const q = normKey(itemQuery);
    return q ? allRows.filter((r) => r.key.includes(q)) : allRows;
  }, [allRows, itemQuery]);

  const emptyApp = receipts.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 16 }}>
      <Segmented
        label="Time period"
        value={period}
        onChange={setPeriod}
        options={[{ value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }, { value: 'all', label: 'All time' }]}
      />

      <SpendDocket range={range} agg={agg} prevTotal={prevTotal} receiptCount={periodReceipts.length} />

      <PrimaryButton onClick={onScan} style={{ justifyContent: 'center', minHeight: 54, fontSize: 17, borderRadius: 14 }}>
        <ScanLine size={20} /> Scan a receipt
      </PrimaryButton>

      {emptyApp ? (
        <div style={{ ...S.card, textAlign: 'center', padding: '28px 20px' }}>
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>No receipts yet</div>
          <div style={{ fontSize: 15, color: COLORS.muted, lineHeight: 1.5 }}>Scan your next Aldi or Woolworths docket and your spending and prices will show up here.</div>
        </div>
      ) : (
        <>
          <div style={S.card}>
            <SectionTitle>Each shop</SectionTitle>
            {tripData.length === 0 ? (
              <div style={{ padding: '24px 0', textAlign: 'center', color: COLORS.muted, fontSize: 15 }}>No shops in this period yet.</div>
            ) : (
              <>
                <div style={{ width: '100%', height: 200 }}>
                  <ResponsiveContainer>
                    <BarChart data={tripData} margin={{ top: 8, right: 4, left: -14, bottom: 0 }}>
                      <CartesianGrid stroke={COLORS.border} vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 12, fill: COLORS.muted }} axisLine={{ stroke: COLORS.border }} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
                      <YAxis tickFormatter={(v) => `$${v}`} tick={{ fontSize: 12, fill: COLORS.muted }} axisLine={false} tickLine={false} width={50} />
                      <Tooltip content={<ChartTooltipContent />} cursor={{ fill: 'rgba(46,58,89,0.06)' }} />
                      <Bar dataKey="y" radius={[5, 5, 0, 0]} maxBarSize={36} isAnimationActive={false}>
                        {tripData.map((d) => <Cell key={d.id} fill={storeColor(d.store)} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <ChartLegend />
              </>
            )}
          </div>

          {risers.length > 0 && (
            <div style={S.card}>
              <SectionTitle>Prices that went up</SectionTitle>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {risers.map((r) => (
                  <button key={r.key} onClick={() => setOpenItem(r.name)} style={S.rowButton}>
                    <span style={{ display: 'flex', alignItems: 'center', minWidth: 0, flex: 1 }}>
                      <StoreDot store={r.lastStore} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                    </span>
                    <span className="mono" style={{ fontSize: 14, color: COLORS.muted, whiteSpace: 'nowrap' }}>{formatAUD(r.prevPrice)} → </span>
                    <span className="mono" style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }}>{formatAUD(r.lastPrice)}</span>
                    <span style={{ fontSize: 14, fontWeight: 600, color: COLORS.priceUp, minWidth: 44, textAlign: 'right' }}>+{Math.round(r.changePct * 100)}%</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={S.card}>
            <SectionTitle right={<span style={{ fontSize: 14, color: COLORS.muted }}>Tap one for its price history</span>}>Items</SectionTitle>
            <div style={{ position: 'relative', marginBottom: 6 }}>
              <Search size={17} color={COLORS.muted} style={{ position: 'absolute', left: 12, top: 14 }} aria-hidden="true" />
              <input
                value={itemQuery}
                onChange={(e) => setItemQuery(e.target.value)}
                placeholder="Find an item"
                aria-label="Find an item"
                type="search"
                style={{ ...S.textInput, paddingLeft: 38 }}
              />
            </div>
            {shownRows.length === 0 ? (
              <div style={{ padding: '18px 0', textAlign: 'center', color: COLORS.muted, fontSize: 15 }}>No items match “{itemQuery}”.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {shownRows.map((row) => (
                  <button key={row.key} onClick={() => setOpenItem(row.name)} style={S.rowButton}>
                    <span style={{ display: 'flex', alignItems: 'center', minWidth: 0, flex: 1 }}>
                      <StoreDot store={row.lastStore} />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
                        <span style={{ display: 'block', fontSize: 13, color: COLORS.muted }}>Bought {row.timesBought}×, last {shortDate(row.lastDate)}</span>
                      </span>
                    </span>
                    <span className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{formatAUD(row.lastPrice)}</span>
                    <PriceChangeIndicator direction={row.direction} />
                  </button>
                ))}
              </div>
            )}
          </div>

          <ManageItemsPanel knownItems={knownItems} onRename={onRenameItem} />
        </>
      )}

      {openItem && <ItemDetailSheet name={openItem} receipts={receipts} onClose={() => setOpenItem(null)} />}
    </div>
  );
}

/* ============================== API KEY PROMPT ============================== */

function ApiKeyForm({ onSave }) {
  const [key, setKey] = useState('');
  return (
    <div style={S.card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <KeyRound size={17} color={COLORS.navy} />
        <span style={{ fontWeight: 700, fontSize: 17 }}>Add your Claude API key</span>
      </div>
      <p style={{ fontSize: 15, color: COLORS.muted, lineHeight: 1.5, margin: '0 0 12px 0' }}>
        This app reads receipts with Claude. Create a key at{' '}
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" style={{ color: COLORS.aldi, fontWeight: 600 }}>
          console.anthropic.com
        </a>{' '}
        (you'll need some API credit), then paste it below. It's stored only on this device and sent only to Anthropic.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-ant-…"
          aria-label="Claude API key"
          autoComplete="off"
          style={S.textInput}
        />
        <PrimaryButton onClick={() => key.trim() && onSave(key.trim())} disabled={!key.trim()}>
          <Save size={15} /> Save
        </PrimaryButton>
      </div>
    </div>
  );
}

/* ============================== RECEIPT REVIEW FORM ============================== */

function ReceiptReviewForm({ draft, setDraft, onSave, onCancel }) {
  function updateItem(id, patch) {
    setDraft((d) => ({ ...d, items: d.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) }));
  }
  function removeItem(id) {
    setDraft((d) => ({ ...d, items: d.items.filter((it) => it.id !== id) }));
  }
  function addItem() {
    setDraft((d) => ({ ...d, items: [...d.items, { id: uid(), name: '', qty: 1, unitPrice: 0 }] }));
  }
  function applyGstShortcut() {
    const gst = Math.round(((Number(draft.total) || 0) / 11) * 100) / 100;
    setDraft((d) => ({ ...d, gst }));
  }


  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={S.card}>
        <div style={S.sectionTitle}>Store and date</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          {STORES.map((s) => (
            <button
              key={s}
              onClick={() => setDraft((d) => ({ ...d, store: s }))}
              style={{
                ...S.button, flex: 1, justifyContent: 'center', minHeight: 48,
                background: draft.store === s ? storeColor(s) : COLORS.field,
                color: draft.store === s ? '#fff' : COLORS.navy,
                border: `1px solid ${draft.store === s ? 'transparent' : COLORS.border}`,
              }}
            >
              {s}
            </button>
          ))}
        </div>
        <input
          type="date"
          value={draft.date || ''}
          onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
          style={S.input}
        />
      </div>

      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={S.sectionTitle}>Items ({draft.items.length})</div>
          <GhostButton onClick={addItem} style={{ padding: '8px 12px' }}>
            <Plus size={16} /> Add item
          </GhostButton>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {draft.items.map((it) => (
            <div key={it.id} style={{ padding: '10px 0', borderBottom: `1px solid ${COLORS.border}` }}>
              <input
                value={it.name}
                onChange={(e) => updateItem(it.id, { name: e.target.value })}
                placeholder="Item name"
                aria-label="Item name"
                style={{ ...S.textInput, marginBottom: 6 }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: COLORS.muted }}>
                  Qty
                  <input
                    type="number" inputMode="decimal" step="0.01" value={it.qty}
                    onChange={(e) => updateItem(it.id, { qty: parseFloat(e.target.value) || 0 })}
                    style={{ ...S.input, width: 72, textAlign: 'center' }}
                  />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: COLORS.muted, flex: 1, whiteSpace: 'nowrap' }}>
                  Price
                  <input
                    type="number" inputMode="decimal" step="0.01" value={it.unitPrice}
                    onChange={(e) => updateItem(it.id, { unitPrice: parseFloat(e.target.value) || 0 })}
                    style={{ ...S.input, textAlign: 'right' }}
                  />
                </label>
                <IconButton label={`Remove ${it.name || 'item'}`} onClick={() => removeItem(it.id)}>
                  <Trash2 size={19} color={COLORS.priceUp} />
                </IconButton>
              </div>
            </div>
          ))}
          {draft.items.length === 0 && (
            <div style={{ fontSize: 15, color: COLORS.muted, padding: '12px 0', textAlign: 'center', lineHeight: 1.5 }}>
              No items found on this receipt. Add them yourself, or scan it again with a flatter, brighter photo.
            </div>
          )}
        </div>
      </div>

      <div style={S.card}>
        <div style={S.sectionTitle}>Totals</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 14, color: COLORS.muted }}>Receipt total</span>
            <input
              type="number" inputMode="decimal" step="0.01" value={draft.total}
              onChange={(e) => setDraft((d) => ({ ...d, total: parseFloat(e.target.value) || 0 }))}
              style={{ ...S.input, fontSize: 17, fontWeight: 600 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 14, color: COLORS.muted }}>GST</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="number" inputMode="decimal" step="0.01" value={draft.gst}
                onChange={(e) => setDraft((d) => ({ ...d, gst: parseFloat(e.target.value) || 0 }))}
                style={S.input}
              />
              <GhostButton onClick={applyGstShortcut} style={{ whiteSpace: 'nowrap' }}>Total ÷ 11</GhostButton>
            </div>
          </label>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <GhostButton onClick={onCancel} style={{ flex: 1, justifyContent: 'center', minHeight: 52 }}>Discard</GhostButton>
        <PrimaryButton onClick={onSave} style={{ flex: 2, justifyContent: 'center', minHeight: 52 }} disabled={!draft.store}>
          <Save size={18} /> Save receipt
        </PrimaryButton>
      </div>
    </div>
  );
}

/* ============================== SCAN RECEIPT TAB ============================== */

function ScanReceiptTab({ apiKey, onSaveApiKey, onSaveReceipt }) {
  const [status, setStatus] = useState('idle'); // idle | working | review | error | saved
  const [errorMsg, setErrorMsg] = useState('');
  const [draft, setDraft] = useState(null);
  const fileInputRef = useRef(null);

  async function handleFile(file) {
    if (!file) return;
    setStatus('working');
    setErrorMsg('');
    try {
      const dataUrl = await resizeImageFile(file, 1568);
      const parsed = await callClaude(dataUrl, apiKey);
      setDraft({
        store: parsed.store || '',
        date: parsed.date || isoToday(),
        gst: parsed.gst != null ? parsed.gst : 0,
        total: parsed.total != null ? parsed.total : 0,
        items: parsed.items.length ? parsed.items : [],
        rawText: parsed.rawText,
      });
      setStatus('review');
    } catch (err) {
      setErrorMsg(err && err.message ? err.message : 'Something went wrong reading that receipt.');
      setStatus('error');
    }
  }

  function reset() {
    setDraft(null);
    setStatus('idle');
    setErrorMsg('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleSave() {
    onSaveReceipt(draft);
    setStatus('saved');
    setTimeout(reset, 1600);
  }

  if (!apiKey) {
    return (
      <div style={{ padding: 16 }}>
        <ApiKeyForm onSave={onSaveApiKey} />
      </div>
    );
  }

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {status !== 'review' && (
        <div style={S.card}>
          <p style={{ fontSize: 15, color: COLORS.muted, margin: '0 0 14px 0', lineHeight: 1.5 }}>
            Photograph an Aldi or Woolworths receipt, or pick one from your photos. You'll check every line before it's saved.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => handleFile(e.target.files && e.target.files[0])}
            style={{ display: 'none' }}
            id="receipt-file-input"
          />
          <label htmlFor="receipt-file-input">
            <div
              style={{
                ...S.button, justifyContent: 'center', width: '100%', background: COLORS.navy, color: '#fff',
                cursor: 'pointer', padding: '16px', fontSize: 17, minHeight: 56,
              }}
            >
              {status === 'working' ? <Loader2 size={18} className="spin" /> : <ImagePlus size={18} />}
              {status === 'working' ? 'Reading receipt…' : 'Take or choose photo'}
            </div>
          </label>

          {status === 'error' && (
            <div style={{ marginTop: 10, background: '#FCEBEA', color: COLORS.priceUp, borderRadius: 10, padding: '10px 12px', fontSize: 15 }}>
              {errorMsg}
            </div>
          )}
          {status === 'saved' && (
            <div style={{ marginTop: 10, background: '#E9F7EF', color: COLORS.priceDown, borderRadius: 10, padding: '10px 12px', fontSize: 15 }}>
              Receipt saved.
            </div>
          )}

          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <button
              onClick={() => onSaveApiKey('')}
              style={{ background: 'transparent', border: 'none', color: COLORS.muted, fontSize: 14, cursor: 'pointer', textDecoration: 'underline', minHeight: 44, padding: '0 8px' }}
            >
              Change Claude API key
            </button>
          </div>
        </div>
      )}

      {status === 'review' && draft && (
        <ReceiptReviewForm draft={draft} setDraft={setDraft} onSave={handleSave} onCancel={reset} />
      )}
    </div>
  );
}

/* ============================== RECEIPTS TAB ============================== */

function ReceiptRow({ receipt, expanded, onToggle }) {
  const unitCount = (receipt.items || []).reduce((s, it) => s + (Number(it.qty) || 0), 0);
  return (
    <div style={{ borderRadius: 14, border: `1px solid ${COLORS.border}`, overflow: 'hidden', background: '#fff' }}>
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        style={{ width: '100%', background: '#fff', border: 'none', cursor: 'pointer', padding: '12px 12px 12px 14px', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', color: COLORS.navy, minHeight: 64 }}
      >
        <div aria-hidden="true" style={{ width: 4, alignSelf: 'stretch', background: storeColor(receipt.store), borderRadius: 4 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{receipt.store}, {formatDateAU(receipt.date)}</div>
          <div style={{ fontSize: 14, color: COLORS.muted, marginTop: 2 }}>
            {unitCount.toLocaleString('en-AU', { maximumFractionDigits: 1 })} items, GST {formatAUD(receipt.gst)}
          </div>
        </div>
        <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>{formatAUD(receipt.total)}</div>
        {expanded ? <ChevronUp size={20} color={COLORS.muted} /> : <ChevronDown size={20} color={COLORS.muted} />}
      </button>
      {expanded && (
        <div style={{ padding: '4px 14px 12px', borderTop: `1px dashed ${COLORS.border}` }}>
          {(receipt.items || []).length === 0 ? (
            <div style={{ fontSize: 15, color: COLORS.muted, padding: '8px 0' }}>No line items recorded.</div>
          ) : receipt.items.map((it) => (
            <div key={it.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, padding: '8px 0', fontSize: 15, borderBottom: `1px solid ${COLORS.border}` }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
              <span style={{ color: COLORS.muted }}>{it.qty !== 1 ? `${it.qty} ×` : ''}</span>
              <span className="mono" style={{ textAlign: 'right', minWidth: 64 }}>{formatAUD(it.unitPrice)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReceiptsTab({ receipts, onScan }) {
  const [store, setStore] = useState('all');
  const [dateFilter, setDateFilter] = useState('');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const shown = useMemo(() => receipts
    .filter((r) => store === 'all' || r.store === store)
    .filter((r) => !dateFilter || r.date === dateFilter)
    .filter((r) => {
      if (!search.trim()) return true;
      const q = normKey(search);
      return (r.items || []).some((it) => normKey(it.name).includes(q));
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)), [receipts, store, dateFilter, search]);

  const total = shown.reduce((s, r) => s + (Number(r.total) || 0), 0);
  const filtered = Boolean(dateFilter || search);

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Segmented
        label="Store"
        value={store}
        onChange={setStore}
        options={[{ value: 'all', label: 'All' }, { value: 'Aldi', label: 'Aldi', accent: COLORS.aldi }, { value: 'Woolworths', label: 'Woolworths', accent: COLORS.woolies }]}
      />

      <div style={{ position: 'relative' }}>
        <Search size={17} color={COLORS.muted} style={{ position: 'absolute', left: 12, top: 14 }} aria-hidden="true" />
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Receipts with an item…" aria-label="Find receipts containing an item" style={{ ...S.textInput, paddingLeft: 38 }} />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 15, color: COLORS.muted, whiteSpace: 'nowrap' }}>On date</span>
        <input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} style={S.input} />
      </label>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 32 }}>
        <span style={{ fontSize: 15, color: COLORS.muted }}>
          {shown.length} receipt{shown.length === 1 ? '' : 's'}, <span className="mono" style={{ color: COLORS.navy, fontWeight: 600 }}>{formatAUD(total)}</span>
        </span>
        {filtered && (
          <button onClick={() => { setDateFilter(''); setSearch(''); }} style={{ ...S.button, background: 'transparent', color: COLORS.navy, padding: '8px 4px', minHeight: 44, textDecoration: 'underline' }}>
            Clear filters
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        <div style={{ ...S.card, textAlign: 'center', padding: '24px 18px' }}>
          {filtered ? (
            <div style={{ fontSize: 15, color: COLORS.muted }}>No receipts match. Try another item or clear the date.</div>
          ) : (
            <>
              <div style={{ fontSize: 15, color: COLORS.muted, marginBottom: 12 }}>No {store === 'all' ? '' : `${store} `}receipts yet.</div>
              <PrimaryButton onClick={onScan} style={{ margin: '0 auto', minHeight: 48 }}><ScanLine size={18} /> Scan a receipt</PrimaryButton>
            </>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shown.map((r) => (
            <ReceiptRow key={r.id} receipt={r} expanded={expandedId === r.id} onToggle={() => setExpandedId((id) => (id === r.id ? null : r.id))} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================== BOTTOM NAV ============================== */

function BottomNav({ active, onChange }) {
  const side = (id, label, Icon) => {
    const on = active === id;
    return (
      <button
        onClick={() => onChange(id)}
        aria-current={on ? 'page' : undefined}
        style={{ flex: 1, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '10px 4px 8px', minHeight: 56, color: on ? COLORS.navy : COLORS.muted }}
      >
        <Icon size={23} strokeWidth={on ? 2.4 : 2} />
        <span style={{ fontSize: 12.5, fontWeight: on ? 700 : 500 }}>{label}</span>
      </button>
    );
  };
  const scanOn = active === 'scan';
  return (
    <nav
      aria-label="Main"
      style={{ position: 'sticky', bottom: 0, background: '#fff', borderTop: `1px solid ${COLORS.border}`, display: 'flex', alignItems: 'flex-end', paddingBottom: 'env(safe-area-inset-bottom, 0px)', zIndex: 50 }}
    >
      {side('dashboard', 'Dashboard', LayoutDashboard)}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
        <button
          onClick={() => onChange('scan')}
          aria-current={scanOn ? 'page' : undefined}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 4px 8px', marginTop: -22, color: COLORS.navy }}
        >
          <span style={{ width: 60, height: 60, borderRadius: 30, background: COLORS.navy, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(46,58,89,0.35)', border: '4px solid #fff' }}>
            <ScanLine size={26} color="#fff" strokeWidth={2.3} />
          </span>
          <span style={{ fontSize: 12.5, fontWeight: 700 }}>Scan</span>
        </button>
      </div>
      {side('receipts', 'Receipts', ReceiptText)}
    </nav>
  );
}

function Header({ title }) {
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 40, background: COLORS.cream, paddingTop: 'env(safe-area-inset-top, 0px)' }}>
      <h1 style={{ margin: 0, padding: '14px 16px 4px', fontSize: 26, fontWeight: 700, color: COLORS.navy, letterSpacing: -0.3 }}>{title}</h1>
    </header>
  );
}

/* ============================== ROOT APP ============================== */

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [receipts, setReceiptsState] = useState(() => getReceipts());
  const [knownItems, setKnownItemsState] = useState(() => getKnownItems());
  const [apiKey, setApiKeyState] = useState(() => getApiKey());
  const [toast, setToast] = useState(null);

  const persistReceipts = useCallback((next) => {
    setReceiptsState(next);
    setReceipts(next);
  }, []);
  const persistKnownItems = useCallback((next) => {
    setKnownItemsState(next);
    setKnownItems(next);
  }, []);

  function handleSaveApiKey(key) {
    setApiKeyState(key);
    setApiKey(key);
  }

  function handleSaveReceipt(draft) {
    const cleanItems = draft.items
      .filter((it) => it.name && it.name.trim())
      .map((it) => ({
        id: it.id || uid(),
        name: it.name.trim(),
        qty: Number(it.qty) || 0,
        unitPrice: Math.round((Number(it.unitPrice) || 0) * 100) / 100,
      }));

    const receipt = {
      id: uid(),
      store: draft.store,
      date: draft.date || isoToday(),
      items: cleanItems,
      total: Math.round((Number(draft.total) || 0) * 100) / 100,
      gst: Math.round((Number(draft.gst) || 0) * 100) / 100,
      rawText: draft.rawText || '',
      createdAt: new Date().toISOString(),
    };

    // Detect new item names before mutating known list.
    const newNames = [];
    for (const it of cleanItems) {
      const already = knownItems.some((k) => normKey(k) === normKey(it.name))
        || newNames.some((n) => normKey(n) === normKey(it.name));
      if (!already) newNames.push(it.name);
    }

    persistReceipts([...receipts, receipt]);
    if (newNames.length) {
      persistKnownItems([...knownItems, ...newNames]);
      const msg = newNames.length === 1
        ? `New item added: ${newNames[0]}`
        : `New items added: ${newNames.join(', ')}`;
      setToast({ id: uid(), message: msg });
    }
  }

  function handleRenameItem(oldName, newName) {
    const oldKey = normKey(oldName);
    const newKey = normKey(newName);

    const nextReceipts = receipts.map((r) => ({
      ...r,
      items: (r.items || []).map((it) => (normKey(it.name) === oldKey ? { ...it, name: newName } : it)),
    }));
    persistReceipts(nextReceipts);

    let nextKnown = knownItems.filter((k) => normKey(k) !== oldKey);
    if (!nextKnown.some((k) => normKey(k) === newKey)) nextKnown = [...nextKnown, newName];
    persistKnownItems(nextKnown);
  }

  const titles = {
    dashboard: 'Dashboard',
    scan: 'Scan a receipt',
    receipts: 'Receipts',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', minHeight: '100dvh' }}>
      <Header title={titles[activeTab]} />
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {activeTab === 'dashboard' && (
          <DashboardTab receipts={receipts} knownItems={knownItems} onRenameItem={handleRenameItem} onScan={() => setActiveTab('scan')} />
        )}
        {activeTab === 'scan' && (
          <ScanReceiptTab apiKey={apiKey} onSaveApiKey={handleSaveApiKey} onSaveReceipt={handleSaveReceipt} />
        )}
        {activeTab === 'receipts' && <ReceiptsTab receipts={receipts} onScan={() => setActiveTab('scan')} />}
      </div>
      <BottomNav active={activeTab} onChange={setActiveTab} />
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<App />);
