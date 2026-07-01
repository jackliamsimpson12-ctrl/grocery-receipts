import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  LayoutDashboard, ScanLine, ShoppingCart, ShoppingBasket, ChevronDown, ChevronUp,
  ChevronRight, Pencil, Check, X, Plus, ArrowUp, ArrowDown, Minus, Calendar, Trash2,
  ImagePlus, Loader2, Sparkles, Tag, Search, KeyRound, Save, RefreshCw,
} from 'lucide-react';

/* ============================== CONSTANTS ============================== */

const COLORS = {
  cream: '#F6F1E6',
  navy: '#2E3A59',
  navySoft: 'rgba(46,58,89,0.65)',
  aldi: '#C1561A',
  woolies: '#1B6B3A',
  card: '#FFFFFF',
  border: 'rgba(46,58,89,0.10)',
  muted: '#6b7593',
  priceUp: '#D64545',
  priceDown: '#2F9E44',
  purple: '#7C4DFF',
};

const STORES = ['Aldi', 'Woolworths'];

const LS_KEYS = {
  RECEIPTS: 'grt_receipts_v1',
  KNOWN_ITEMS: 'grt_known_items_v1',
  OCR_KEY: 'grt_ocr_api_key_v1',
};

const SKIP_LINE_RE = new RegExp(
  '\\b(TOTAL|SUBTOTAL|SUB TOTAL|SUB-TOTAL|GST|EFTPOS|CASH|CHANGE|BALANCE|VISA|' +
  'MASTERCARD|AMEX|AUTH|APPROVED|CARD NO|CARD|TENDERED|PURCHASE|REFERENCE|TERMINAL|' +
  'MERCHANT|ABN|RECEIPT NO|TAX INVOICE|THANK YOU|ITEMS SOLD|QTY|DOCKET|OPERATOR|' +
  'SAVINGS|LOYALTY|REWARDS|MEMBER|POINTS|SURCHARGE|ROUNDING|ROUND|EFT|AID |AVAILABLE|' +
  'AVAIL BAL|AMOUNT DUE|AUTH CODE|AUTH NO|TRANS ID|TRANS NO|AISLE|STORE #|PHONE|WWW\\.|' +
  'HTTP|CHEQUE|DEBIT|CREDIT|EFTPOS AVAIL|NUMBER OF ITEMS|# OF ITEMS)\\b',
  'i'
);

const HEADER_STORE_RE = { ALDI: /\bALDI\b/i, WOOLWORTHS: /\bWOOLWORTHS\b|\bWOOLIES\b/i };

const DATE_RE = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/;
const GST_LINE_RE = /GST[^0-9]*(\d{1,4}\.\d{2})/i;
const TOTAL_LINE_RE = /^\s*TOTAL\b(?!.*SUB)[^0-9]*\$?(\d{1,5}\.\d{2})/i;
const ITEM_LINE_RE = /^(.+?)\s+\$?(\d{1,5}\.\d{2})\s*[A-Za-z]{0,2}\*?\s*$/;
const QTY_PREFIX_RE = /^(\d+(?:\.\d+)?)\s*[xX]\s*(.+)$/;
const LEADING_SKU_RE = /^\d{4,}\s+/;

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
  return localStorage.getItem(LS_KEYS.OCR_KEY) || '';
}
function setApiKey(key) {
  localStorage.setItem(LS_KEYS.OCR_KEY, key || '');
}

/* ============================== RECEIPT TEXT PARSER ============================== */

function parseReceiptText(rawText) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let store = null;
  for (const line of lines) {
    if (HEADER_STORE_RE.ALDI.test(line)) { store = 'Aldi'; break; }
    if (HEADER_STORE_RE.WOOLWORTHS.test(line)) { store = 'Woolworths'; break; }
  }

  let date = null;
  for (const line of lines) {
    const m = line.match(DATE_RE);
    if (m) {
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        date = isoFromParts(day, month, m[3]);
        break;
      }
    }
  }

  let gst = null;
  for (const line of lines) {
    const m = line.match(GST_LINE_RE);
    if (m) { gst = parseFloat(m[1]); break; }
  }

  let total = null;
  for (const line of lines) {
    const m = line.match(TOTAL_LINE_RE);
    if (m) { total = parseFloat(m[1]); break; }
  }

  const items = [];
  for (const line of lines) {
    if (SKIP_LINE_RE.test(line)) continue;
    const m = line.match(ITEM_LINE_RE);
    if (!m) continue;
    let namePart = m[1].trim().replace(LEADING_SKU_RE, '').trim();
    const price = parseFloat(m[2]);
    if (!namePart || Number.isNaN(price)) continue;
    if (namePart.length < 2) continue;

    let qty = 1;
    let unitPrice = price;
    const qtyMatch = namePart.match(QTY_PREFIX_RE);
    if (qtyMatch) {
      qty = parseFloat(qtyMatch[1]);
      namePart = qtyMatch[2].trim();
      unitPrice = qty > 0 ? price / qty : price;
    }

    items.push({
      id: uid(),
      name: namePart,
      qty,
      unitPrice: Math.round(unitPrice * 100) / 100,
    });
  }

  return { store, date, gst, total, items };
}

/* ============================== IMAGE RESIZE + OCR ============================== */

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

async function callOcrSpace(base64DataUrl, apiKey) {
  const form = new FormData();
  form.append('apikey', apiKey);
  form.append('base64Image', base64DataUrl);
  form.append('language', 'eng');
  form.append('isOverlayRequired', 'false');
  form.append('OCREngine', '2');
  form.append('scale', 'true');
  form.append('detectOrientation', 'true');

  const res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`OCR request failed (${res.status})`);
  const data = await res.json();
  if (data.IsErroredOnProcessing) {
    const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(', ') : (data.ErrorMessage || 'OCR processing error');
    throw new Error(msg);
  }
  return (data.ParsedResults && data.ParsedResults[0] && data.ParsedResults[0].ParsedText) || '';
}

/* ============================== SHARED STYLES ============================== */

const S = {
  card: {
    background: COLORS.card,
    borderRadius: 18,
    padding: 16,
    boxShadow: '0 2px 10px rgba(46,58,89,0.08)',
    border: `1px solid ${COLORS.border}`,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: COLORS.muted,
    margin: '0 0 10px 0',
  },
  input: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 15,
    padding: '9px 12px',
    borderRadius: 10,
    border: `1px solid ${COLORS.border}`,
    background: '#FCFAF5',
    color: COLORS.navy,
    outline: 'none',
    width: '100%',
  },
  textInput: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 15,
    padding: '9px 12px',
    borderRadius: 10,
    border: `1px solid ${COLORS.border}`,
    background: '#FCFAF5',
    color: COLORS.navy,
    outline: 'none',
    width: '100%',
  },
  button: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontWeight: 600,
    fontSize: 14,
    padding: '10px 16px',
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
          background: COLORS.purple,
          color: '#fff',
          borderRadius: 14,
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          boxShadow: '0 8px 24px rgba(124,77,255,0.35)',
          maxWidth: 460,
          width: '100%',
        }}
      >
        <Sparkles size={18} style={{ flexShrink: 0 }} />
        <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.35 }}>{toast.message}</div>
        <button
          onClick={onDismiss}
          style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', padding: 4 }}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

/* ============================== SUMMARY CARD ============================== */

function SummaryCard({ label, value, sub, accent }) {
  return (
    <div style={{ ...S.card, padding: 14, minWidth: 0 }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase', color: COLORS.muted, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 600, color: accent || COLORS.navy, lineHeight: 1.1 }}>
        {value}
      </div>
      {sub ? <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 4 }}>{sub}</div> : null}
    </div>
  );
}

function StoreDot({ store }) {
  const color = store === 'Aldi' ? COLORS.aldi : COLORS.woolies;
  return <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: color, marginRight: 6 }} />;
}

function PriceChangeIndicator({ direction }) {
  if (direction === 'up') return <ArrowUp size={14} color={COLORS.priceUp} style={{ verticalAlign: 'middle' }} />;
  if (direction === 'down') return <ArrowDown size={14} color={COLORS.priceDown} style={{ verticalAlign: 'middle' }} />;
  return <Minus size={13} color={COLORS.muted} style={{ verticalAlign: 'middle', opacity: 0.5 }} />;
}

/* ============================== DERIVED DATA HELPERS ============================== */

function computeAggregates(receipts) {
  let totalSpend = 0, aldiSpend = 0, wooliesSpend = 0, aldiTrips = 0, wooliesTrips = 0;
  let totalItems = 0, totalGst = 0;
  for (const r of receipts) {
    const total = Number(r.total) || 0;
    totalSpend += total;
    totalGst += Number(r.gst) || 0;
    if (r.store === 'Aldi') { aldiSpend += total; aldiTrips += 1; }
    else if (r.store === 'Woolworths') { wooliesSpend += total; wooliesTrips += 1; }
    for (const it of (r.items || [])) totalItems += Number(it.qty) || 0;
  }
  return { totalSpend, aldiSpend, wooliesSpend, aldiTrips, wooliesTrips, totalItems, totalGst };
}

// Every occurrence of every item, sorted chronologically, grouped by normalized name.
function buildItemHistory(receipts) {
  const groups = new Map(); // normKey -> { name, occurrences: [{date, unitPrice, store, receiptId}] }
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
  const groups = buildItemHistory(receipts);
  const rows = [];
  for (const [key, g] of groups.entries()) {
    const occ = g.occurrences;
    const last = occ[occ.length - 1];
    const prev = occ.length > 1 ? occ[occ.length - 2] : null;
    let direction = 'flat';
    if (prev) {
      if (last.unitPrice > prev.unitPrice) direction = 'up';
      else if (last.unitPrice < prev.unitPrice) direction = 'down';
    }
    rows.push({
      key, name: g.name, timesBought: occ.length, lastPrice: last.unitPrice,
      lastDate: last.date, lastStore: last.store, direction,
      totalQty: occ.reduce((s, o) => s + o.qty, 0),
    });
  }
  rows.sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0));
  return rows;
}

function totalSpendChartData(receipts) {
  return [...receipts]
    .filter((r) => r.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((r) => ({
      x: new Date(r.date + 'T00:00:00').getTime(),
      y: Number(r.total) || 0,
      store: r.store,
      dateLabel: formatDateAU(r.date),
    }));
}

function itemChartData(receipts, query) {
  const qKey = normKey(query);
  if (!qKey) return [];
  const points = [];
  for (const r of receipts) {
    if (!r.date) continue;
    for (const it of (r.items || [])) {
      if (normKey(it.name).includes(qKey)) {
        points.push({
          x: new Date(r.date + 'T00:00:00').getTime(),
          y: Number(it.unitPrice) || 0,
          store: r.store,
          dateLabel: formatDateAU(r.date),
          name: it.name,
        });
      }
    }
  }
  points.sort((a, b) => a.x - b.x);
  return points;
}

function matchingKnownItems(knownItems, query, limit = 6) {
  const qKey = normKey(query);
  if (!qKey) return [];
  return knownItems.filter((n) => normKey(n).includes(qKey)).slice(0, limit);
}

/* ============================== CUSTOM CHART DOT ============================== */

function StoreColoredDot(props) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null) return null;
  const color = payload && payload.store === 'Aldi' ? COLORS.aldi
    : payload && payload.store === 'Woolworths' ? COLORS.woolies
    : COLORS.navy;
  return <circle cx={cx} cy={cy} r={5} fill={color} stroke="#fff" strokeWidth={1.5} />;
}

function ChartTooltipContent({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{ background: COLORS.navy, color: '#fff', padding: '8px 12px', borderRadius: 10, fontSize: 13 }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600 }}>{formatAUD(p.y)}</div>
      <div style={{ opacity: 0.85, fontSize: 12, marginTop: 2 }}>{p.dateLabel} · {p.store || 'Unknown'}</div>
    </div>
  );
}

/* ============================== MANAGE ITEM NAMES PANEL ============================== */

function ManageItemsPanel({ knownItems, onRename }) {
  const [open, setOpen] = useState(false);
  const [editingKey, setEditingKey] = useState(null);
  const [draft, setDraft] = useState('');

  const sorted = useMemo(() => [...knownItems].sort((a, b) => a.localeCompare(b)), [knownItems]);

  function startEdit(name) {
    setEditingKey(normKey(name));
    setDraft(name);
  }
  function commitEdit(oldName) {
    const newName = draft.trim();
    setEditingKey(null);
    if (!newName || normKey(newName) === normKey(oldName)) return;
    onRename(oldName, newName);
  }

  return (
    <div style={{ ...S.card, marginTop: 14 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          background: 'transparent', border: 'none', width: '100%', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Tag size={16} color={COLORS.navy} />
          <span style={{ fontWeight: 600, fontSize: 15, color: COLORS.navy }}>Manage item names</span>
          <span style={{ fontSize: 12, color: COLORS.muted }}>({knownItems.length})</span>
        </div>
        {open ? <ChevronUp size={18} color={COLORS.navy} /> : <ChevronDown size={18} color={COLORS.navy} />}
      </button>

      {open && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
          {sorted.length === 0 && (
            <div style={{ fontSize: 13, color: COLORS.muted, padding: '8px 0' }}>No items scanned yet.</div>
          )}
          {sorted.map((name) => {
            const isEditing = editingKey === normKey(name);
            return (
              <div
                key={name}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                  borderRadius: 10, background: '#FCFAF5', border: `1px solid ${COLORS.border}`,
                }}
              >
                {isEditing ? (
                  <>
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(name); if (e.key === 'Escape') setEditingKey(null); }}
                      style={{ ...S.textInput, padding: '6px 10px', fontSize: 14 }}
                    />
                    <button onClick={() => commitEdit(name)} style={{ background: COLORS.navy, border: 'none', borderRadius: 8, padding: 6, cursor: 'pointer' }}>
                      <Check size={14} color="#fff" />
                    </button>
                    <button onClick={() => setEditingKey(null)} style={{ background: 'transparent', border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 6, cursor: 'pointer' }}>
                      <X size={14} color={COLORS.navy} />
                    </button>
                  </>
                ) : (
                  <>
                    <span style={{ flex: 1, fontSize: 14, color: COLORS.navy }}>{name}</span>
                    <button onClick={() => startEdit(name)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 6 }}>
                      <Pencil size={14} color={COLORS.muted} />
                    </button>
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

function DashboardTab({ receipts, knownItems, onRenameItem }) {
  const [itemQuery, setItemQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  const agg = useMemo(() => computeAggregates(receipts), [receipts]);
  const historyRows = useMemo(() => itemHistoryRows(receipts), [receipts]);
  const suggestions = useMemo(() => matchingKnownItems(knownItems, itemQuery), [knownItems, itemQuery]);

  const chartData = useMemo(() => {
    if (itemQuery.trim()) return itemChartData(receipts, itemQuery);
    return totalSpendChartData(receipts);
  }, [receipts, itemQuery]);

  const chartTitle = itemQuery.trim() ? `Price history: "${itemQuery.trim()}"` : 'Total receipt price over time';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <SummaryCard label="Total spend" value={formatAUD(agg.totalSpend)} sub={`${receipts.length} receipts`} />
        <SummaryCard label="Total GST paid" value={formatAUD(agg.totalGst)} />
        <SummaryCard label="Aldi" value={formatAUD(agg.aldiSpend)} sub={`${agg.aldiTrips} trip${agg.aldiTrips === 1 ? '' : 's'}`} accent={COLORS.aldi} />
        <SummaryCard label="Woolworths" value={formatAUD(agg.wooliesSpend)} sub={`${agg.wooliesTrips} trip${agg.wooliesTrips === 1 ? '' : 's'}`} accent={COLORS.woolies} />
        <SummaryCard label="Total items bought" value={agg.totalItems.toLocaleString('en-AU', { maximumFractionDigits: 1 })} sub="across all receipts" />
      </div>

      <div style={S.card}>
        <div style={S.sectionTitle}>{chartTitle}</div>
        <div style={{ position: 'relative', marginBottom: 10 }}>
          <Search size={15} color={COLORS.muted} style={{ position: 'absolute', left: 10, top: 11 }} />
          <input
            value={itemQuery}
            onChange={(e) => { setItemQuery(e.target.value); setShowSuggestions(true); }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            placeholder="Type an item name to see its price history…"
            style={{ ...S.textInput, paddingLeft: 32 }}
          />
          {showSuggestions && suggestions.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 4,
              background: '#fff', border: `1px solid ${COLORS.border}`, borderRadius: 10,
              boxShadow: '0 6px 18px rgba(46,58,89,0.15)', overflow: 'hidden',
            }}>
              {suggestions.map((s) => (
                <div
                  key={s}
                  onMouseDown={() => { setItemQuery(s); setShowSuggestions(false); }}
                  style={{ padding: '9px 12px', fontSize: 14, cursor: 'pointer', borderBottom: `1px solid ${COLORS.border}` }}
                >
                  {s}
                </div>
              ))}
            </div>
          )}
          {itemQuery && (
            <button
              onClick={() => setItemQuery('')}
              style={{ position: 'absolute', right: 8, top: 8, background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              <X size={16} color={COLORS.muted} />
            </button>
          )}
        </div>

        {chartData.length === 0 ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: COLORS.muted, fontSize: 14 }}>
            {itemQuery.trim() ? 'No purchases found for that item yet.' : 'Scan a receipt to see your spending graph.'}
          </div>
        ) : (
          <div style={{ width: '100%', height: 240 }}>
            <ResponsiveContainer>
              <LineChart data={chartData} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                <CartesianGrid stroke={COLORS.border} vertical={false} />
                <XAxis
                  dataKey="x" type="number" domain={['dataMin', 'dataMax']}
                  tickFormatter={(v) => formatDateAU(new Date(v))}
                  tick={{ fontSize: 11, fill: COLORS.muted }}
                  axisLine={{ stroke: COLORS.border }} tickLine={false}
                />
                <YAxis
                  tickFormatter={(v) => `$${v}`}
                  tick={{ fontSize: 11, fill: COLORS.muted }}
                  axisLine={{ stroke: COLORS.border }} tickLine={false} width={48}
                />
                <Tooltip content={<ChartTooltipContent />} />
                <Line
                  type="monotone" dataKey="y" stroke={COLORS.navy} strokeWidth={2}
                  dot={<StoreColoredDot />} activeDot={{ r: 7 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 12, color: COLORS.muted }}>
          <span><StoreDot store="Aldi" />Aldi</span>
          <span><StoreDot store="Woolworths" />Woolworths</span>
        </div>
      </div>

      <div style={S.card}>
        <div style={S.sectionTitle}>Item history</div>
        {historyRows.length === 0 ? (
          <div style={{ padding: '20px 0', textAlign: 'center', color: COLORS.muted, fontSize: 14 }}>No items yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 8, fontSize: 11, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.3, padding: '4px 6px', borderBottom: `1px solid ${COLORS.border}` }}>
              <span>Item</span><span>Last price</span><span>Trend</span><span>Bought</span>
            </div>
            {historyRows.map((row) => (
              <div key={row.key} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 8, alignItems: 'center', padding: '9px 6px', borderBottom: `1px solid ${COLORS.border}` }}>
                <span style={{ fontSize: 13.5, color: COLORS.navy, display: 'flex', alignItems: 'center', minWidth: 0 }}>
                  <StoreDot store={row.lastStore} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
                </span>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13.5, fontWeight: 600 }}>{formatAUD(row.lastPrice)}</span>
                <PriceChangeIndicator direction={row.direction} />
                <span style={{ fontSize: 12.5, color: COLORS.muted }}>×{row.timesBought}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <ManageItemsPanel knownItems={knownItems} onRename={onRenameItem} />
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
        <span style={{ fontWeight: 600, fontSize: 15 }}>Add your OCR.space API key</span>
      </div>
      <p style={{ fontSize: 13.5, color: COLORS.muted, lineHeight: 1.5, margin: '0 0 12px 0' }}>
        This app reads receipts using the free OCR.space API. Get a free key at{' '}
        <a href="https://ocr.space/ocrapi/freekey" target="_blank" rel="noreferrer" style={{ color: COLORS.aldi, fontWeight: 600 }}>
          ocr.space/ocrapi/freekey
        </a>{' '}
        then paste it below. It's stored only on this device.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Paste your API key…"
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

  const itemCount = draft.items.reduce((s, it) => s + (Number(it.qty) || 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={S.card}>
        <div style={S.sectionTitle}>Store & date</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          {STORES.map((s) => (
            <button
              key={s}
              onClick={() => setDraft((d) => ({ ...d, store: s }))}
              style={{
                ...S.button, flex: 1, justifyContent: 'center',
                background: draft.store === s ? (s === 'Aldi' ? COLORS.aldi : COLORS.woolies) : '#FCFAF5',
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
          <div style={S.sectionTitle}>Items ({itemCount.toLocaleString('en-AU', { maximumFractionDigits: 1 })})</div>
          <button onClick={addItem} style={{ ...S.button, background: 'transparent', border: `1px solid ${COLORS.border}`, padding: '6px 10px', fontSize: 12.5 }}>
            <Plus size={13} /> Add item
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 52px 76px 28px', gap: 6, fontSize: 10.5, color: COLORS.muted, textTransform: 'uppercase', padding: '0 4px 4px' }}>
          <span>Name</span><span>Qty</span><span>Unit $</span><span />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
          {draft.items.map((it) => (
            <div key={it.id} style={{ display: 'grid', gridTemplateColumns: '1fr 52px 76px 28px', gap: 6, alignItems: 'center' }}>
              <input
                value={it.name}
                onChange={(e) => updateItem(it.id, { name: e.target.value })}
                placeholder="Item name"
                style={{ ...S.textInput, padding: '7px 9px', fontSize: 13.5 }}
              />
              <input
                type="number" step="0.01" value={it.qty}
                onChange={(e) => updateItem(it.id, { qty: parseFloat(e.target.value) || 0 })}
                style={{ ...S.input, padding: '7px 6px', fontSize: 13, textAlign: 'center' }}
              />
              <input
                type="number" step="0.01" value={it.unitPrice}
                onChange={(e) => updateItem(it.id, { unitPrice: parseFloat(e.target.value) || 0 })}
                style={{ ...S.input, padding: '7px 6px', fontSize: 13, textAlign: 'right' }}
              />
              <button onClick={() => removeItem(it.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4 }}>
                <Trash2 size={14} color={COLORS.priceUp} />
              </button>
            </div>
          ))}
          {draft.items.length === 0 && (
            <div style={{ fontSize: 13, color: COLORS.muted, padding: '10px 0', textAlign: 'center' }}>
              No items detected — add them manually, or try scanning again.
            </div>
          )}
        </div>
      </div>

      <div style={S.card}>
        <div style={S.sectionTitle}>Totals</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: COLORS.muted }}>Receipt total</span>
            <input
              type="number" step="0.01" value={draft.total}
              onChange={(e) => setDraft((d) => ({ ...d, total: parseFloat(e.target.value) || 0 }))}
              style={{ ...S.input, fontSize: 17, fontWeight: 600 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: COLORS.muted }}>GST</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="number" step="0.01" value={draft.gst}
                onChange={(e) => setDraft((d) => ({ ...d, gst: parseFloat(e.target.value) || 0 }))}
                style={S.input}
              />
              <GhostButton onClick={applyGstShortcut} style={{ whiteSpace: 'nowrap' }}>÷11</GhostButton>
            </div>
          </label>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <GhostButton onClick={onCancel} style={{ flex: 1, justifyContent: 'center' }}>Cancel</GhostButton>
        <PrimaryButton onClick={onSave} style={{ flex: 2, justifyContent: 'center' }} disabled={!draft.store}>
          <Save size={16} /> Save to dashboard
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
      const dataUrl = await resizeImageFile(file, 1400);
      const text = await callOcrSpace(dataUrl, apiKey);
      const parsed = parseReceiptText(text);
      setDraft({
        store: parsed.store || '',
        date: parsed.date || isoToday(),
        gst: parsed.gst != null ? parsed.gst : 0,
        total: parsed.total != null ? parsed.total : 0,
        items: parsed.items.length ? parsed.items : [],
        rawText: text,
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
          <div style={S.sectionTitle}>Scan a receipt</div>
          <p style={{ fontSize: 13.5, color: COLORS.muted, margin: '0 0 14px 0', lineHeight: 1.5 }}>
            Take a photo (or choose one from your library) of an Aldi or Woolworths receipt. We'll read it and let you check everything before saving.
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
                cursor: 'pointer', padding: '14px 16px', fontSize: 15,
              }}
            >
              {status === 'working' ? <Loader2 size={18} className="spin" /> : <ImagePlus size={18} />}
              {status === 'working' ? 'Reading receipt…' : 'Take or choose photo'}
            </div>
          </label>

          {status === 'error' && (
            <div style={{ marginTop: 10, background: '#FCEBEA', color: COLORS.priceUp, borderRadius: 10, padding: '10px 12px', fontSize: 13 }}>
              {errorMsg}
            </div>
          )}
          {status === 'saved' && (
            <div style={{ marginTop: 10, background: '#E9F7EF', color: COLORS.priceDown, borderRadius: 10, padding: '10px 12px', fontSize: 13 }}>
              Saved to your dashboard!
            </div>
          )}

          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <button
              onClick={() => onSaveApiKey('')}
              style={{ background: 'transparent', border: 'none', color: COLORS.muted, fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}
            >
              Change OCR.space API key
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

/* ============================== STORE TAB (Aldi / Woolworths) ============================== */

function ReceiptRow({ receipt, expanded, onToggle }) {
  const accent = receipt.store === 'Aldi' ? COLORS.aldi : COLORS.woolies;
  const unitCount = (receipt.items || []).reduce((s, it) => s + (Number(it.qty) || 0), 0);
  return (
    <div style={{ borderRadius: 14, border: `1px solid ${COLORS.border}`, overflow: 'hidden', marginBottom: 10 }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%', background: '#FCFAF5', border: 'none', cursor: 'pointer',
          padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
        }}
      >
        <div style={{ width: 4, alignSelf: 'stretch', background: accent, borderRadius: 4, minHeight: 32 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 600, color: COLORS.navy }}>{formatDateAU(receipt.date)}</div>
          <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 2 }}>
            {unitCount.toLocaleString('en-AU', { maximumFractionDigits: 1 })} items · GST {formatAUD(receipt.gst)}
          </div>
        </div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, fontSize: 16, color: COLORS.navy }}>
          {formatAUD(receipt.total)}
        </div>
        {expanded ? <ChevronUp size={18} color={COLORS.muted} /> : <ChevronDown size={18} color={COLORS.muted} />}
      </button>
      {expanded && (
        <div style={{ padding: '10px 14px 14px', background: '#fff' }}>
          {(receipt.items || []).length === 0 ? (
            <div style={{ fontSize: 13, color: COLORS.muted }}>No line items recorded.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 40px 70px', gap: 6, fontSize: 10.5, color: COLORS.muted, textTransform: 'uppercase', paddingBottom: 4, borderBottom: `1px solid ${COLORS.border}` }}>
                <span>Item</span><span>Qty</span><span>Unit $</span>
              </div>
              {receipt.items.map((it) => (
                <div key={it.id} style={{ display: 'grid', gridTemplateColumns: '1fr 40px 70px', gap: 6, padding: '6px 0', fontSize: 13.5 }}>
                  <span style={{ color: COLORS.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
                  <span style={{ color: COLORS.muted }}>{it.qty}</span>
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{formatAUD(it.unitPrice)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StoreTab({ store, receipts }) {
  const accent = store === 'Aldi' ? COLORS.aldi : COLORS.woolies;
  const [dateFilter, setDateFilter] = useState('');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const storeReceipts = useMemo(() => {
    return receipts
      .filter((r) => r.store === store)
      .filter((r) => !dateFilter || r.date === dateFilter)
      .filter((r) => {
        if (!search.trim()) return true;
        const q = normKey(search);
        return (r.items || []).some((it) => normKey(it.name).includes(q));
      })
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [receipts, store, dateFilter, search]);

  const agg = useMemo(() => {
    const totalSpend = storeReceipts.reduce((s, r) => s + (Number(r.total) || 0), 0);
    const totalGst = storeReceipts.reduce((s, r) => s + (Number(r.gst) || 0), 0);
    return { totalSpend, totalGst, trips: storeReceipts.length };
  }, [storeReceipts]);

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {store === 'Aldi' ? <ShoppingCart size={22} color={accent} /> : <ShoppingBasket size={22} color={accent} />}
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, color: COLORS.navy }}>{store}</div>
          <div style={{ fontSize: 12.5, color: COLORS.muted }}>{agg.trips} receipt{agg.trips === 1 ? '' : 's'} · {formatAUD(agg.totalSpend)} · GST {formatAUD(agg.totalGst)}</div>
        </div>
      </div>

      <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ position: 'relative' }}>
          <Search size={15} color={COLORS.muted} style={{ position: 'absolute', left: 10, top: 11 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by item name…"
            style={{ ...S.textInput, paddingLeft: 32 }}
          />
        </div>
        <div style={{ position: 'relative' }}>
          <Calendar size={15} color={COLORS.muted} style={{ position: 'absolute', left: 10, top: 11, pointerEvents: 'none' }} />
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            style={{ ...S.input, paddingLeft: 32 }}
          />
        </div>
        {(dateFilter || search) && (
          <button
            onClick={() => { setDateFilter(''); setSearch(''); }}
            style={{ alignSelf: 'flex-start', background: 'transparent', border: 'none', color: COLORS.muted, fontSize: 12.5, cursor: 'pointer', textDecoration: 'underline' }}
          >
            Clear filters
          </button>
        )}
      </div>

      <div>
        {storeReceipts.length === 0 ? (
          <div style={{ ...S.card, textAlign: 'center', color: COLORS.muted, fontSize: 14 }}>
            No {store} receipts {dateFilter || search ? 'match those filters' : 'yet — scan one to get started'}.
          </div>
        ) : (
          storeReceipts.map((r) => (
            <ReceiptRow
              key={r.id}
              receipt={r}
              expanded={expandedId === r.id}
              onToggle={() => setExpandedId((id) => (id === r.id ? null : r.id))}
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ============================== BOTTOM NAV ============================== */

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, accent: COLORS.navy },
  { id: 'scan', label: 'Scan Receipt', icon: ScanLine, accent: COLORS.navy },
  { id: 'aldi', label: 'Aldi', icon: ShoppingCart, accent: COLORS.aldi },
  { id: 'woolworths', label: 'Woolworths', icon: ShoppingBasket, accent: COLORS.woolies },
];

function BottomNav({ active, onChange }) {
  return (
    <div
      style={{
        position: 'sticky', bottom: 0, left: 0, right: 0,
        background: '#fff', borderTop: `1px solid ${COLORS.border}`,
        display: 'flex', paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        boxShadow: '0 -4px 16px rgba(46,58,89,0.06)', zIndex: 50,
      }}
    >
      {TABS.map((t) => {
        const Icon = t.icon;
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              flex: 1, background: 'transparent', border: 'none', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
              padding: '10px 4px 8px', color: isActive ? t.accent : COLORS.muted,
            }}
          >
            <Icon size={21} color={isActive ? t.accent : COLORS.muted} strokeWidth={isActive ? 2.4 : 2} />
            <span style={{ fontSize: 10.5, fontWeight: isActive ? 700 : 500 }}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Header({ title }) {
  return (
    <div
      style={{
        position: 'sticky', top: 0, zIndex: 40, background: COLORS.cream,
        paddingTop: 'env(safe-area-inset-top, 0px)', borderBottom: `1px solid ${COLORS.border}`,
      }}
    >
      <div style={{ padding: '14px 16px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 19, fontWeight: 700, color: COLORS.navy }}>{title}</div>
      </div>
    </div>
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
    scan: 'Scan Receipt',
    aldi: 'Aldi',
    woolworths: 'Woolworths',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', minHeight: '100dvh' }}>
      <Header title={titles[activeTab]} />
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {activeTab === 'dashboard' && (
          <DashboardTab receipts={receipts} knownItems={knownItems} onRenameItem={handleRenameItem} />
        )}
        {activeTab === 'scan' && (
          <ScanReceiptTab apiKey={apiKey} onSaveApiKey={handleSaveApiKey} onSaveReceipt={handleSaveReceipt} />
        )}
        {activeTab === 'aldi' && <StoreTab store="Aldi" receipts={receipts} />}
        {activeTab === 'woolworths' && <StoreTab store="Woolworths" receipts={receipts} />}
      </div>
      <BottomNav active={activeTab} onChange={setActiveTab} />
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<App />);
