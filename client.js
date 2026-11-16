window.__ModuleLoader__.load({
  id: 'dsh-plugin-evalforge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React;

    const NS = 'evalforge';
    const API_BASE = new URL('./api/evalforge/', document.baseURI).pathname;
    const ACTIVE = new Set(['queued', 'running']);

    const TASK_LABEL = {
      endpoint_selection: ['主要终点匹配', 'Primary Endpoint Selection'],
      eligibility_criteria_matching: ['纳排标准匹配', 'Eligibility Criteria Matching'],
      trial_completion_prediction: ['试验完成预测（实验性）', 'Completion Prediction (experimental)'],
    };
    const STATUS_TONE = { valid: 'success', needs_review: 'warn', invalid: 'danger' };

    const zh = { nav: 'EvalForge' };
    const en = { nav: 'EvalForge' };

    function cx(...parts) {
      return parts.filter(Boolean).join(' ');
    }

    async function api(path, options = {}) {
      const init = {
        method: options.method || 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      };
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(`${API_BASE}${path}`, init);
      const type = response.headers.get('content-type') || '';
      const payload = type.includes('application/json') ? await response.json() : await response.text();
      if (!response.ok) {
        const err = new Error((payload && payload.error) || `HTTP ${response.status}`);
        err.code = payload && payload.code;
        throw err;
      }
      return payload;
    }

    async function download(path, fallbackName) {
      const response = await fetch(`${API_BASE}${path}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`export failed: HTTP ${response.status}`);
      const disposition = response.headers.get('content-disposition') || '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = match ? match[1] : fallbackName;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    }

    function useLang(locale) {
      if (!locale || typeof locale.subscribe !== 'function') return 'zh';
      const snapshot = useSyncExternalStore(
        (cb) => locale.subscribe(cb),
        () => locale.getSnapshot(),
        () => locale.getSnapshot(),
      );
      return String((snapshot && snapshot.active) || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    const fmtPct = (value) => (value === null || value === undefined ? '—' : `${(Number(value) * 100).toFixed(1)}%`);
    const fmtNum = (value, digits = 2) => (value === null || value === undefined ? '—' : Number(value).toFixed(digits));
    const fmtDate = (value) => {
      if (!value) return '—';
      try {
        return new Date(value).toLocaleString(undefined, { hour12: false });
      } catch {
        return String(value);
      }
    };
    const fmtBytes = (value) => {
      if (!value) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let size = Number(value);
      let index = 0;
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }
      return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
    };

    /* ------------------------------- styles ------------------------------- */

    const CSS = `
      .me-root { --me-gap: 14px; color: var(--dsw-alias-label-primary, #1f2328); font-size: 13px; }
      .me-root * { box-sizing: border-box; }
      .me-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
      .me-brand { display: flex; align-items: center; gap: 12px; }
      .me-brand-mark { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; color: #fff; font-weight: 800; letter-spacing: .02em;
        background: linear-gradient(135deg, var(--dsw-alias-brand-primary, #2f6fed), #14b8a6); box-shadow: var(--dsw-shadow-lv1, 0 1px 2px #0001); }
      .me-brand h1 { margin: 0; font-size: 17px; font-weight: 700; letter-spacing: -.01em; }
      .me-brand p { margin: 3px 0 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #5c6570); }
      .me-chips { display: flex; gap: 8px; flex-wrap: wrap; }
      .me-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; font-size: 11.5px;
        border: 1px solid var(--dsw-alias-border-l2, #e5e7eb); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-secondary, #5c6570); }
      .me-chip b { color: var(--dsw-alias-label-primary, #1f2328); font-variant-numeric: tabular-nums; }
      .me-tabs { display: flex; gap: 4px; padding: 4px; border-radius: 12px; background: var(--dsw-alias-bg-layer-2, #f3f4f6); margin-bottom: 14px; width: fit-content; flex-wrap: wrap; }
      .me-tab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #5c6570); font: inherit; font-size: 12.5px; font-weight: 600;
        padding: 7px 14px; border-radius: 9px; cursor: pointer; }
      .me-tab:hover { color: var(--dsw-alias-label-primary, #1f2328); }
      .me-tab.active { background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1f2328); box-shadow: var(--dsw-shadow-lv1, 0 1px 2px #0001); }
      .me-grid { display: grid; gap: var(--me-gap); }
      .me-grid-2 { grid-template-columns: minmax(300px, 400px) minmax(0, 1fr); }
      .me-grid-3 { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
      @media (max-width: 980px) { .me-grid-2 { grid-template-columns: 1fr; } }
      .me-card { background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1, #fff)); border: .5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l3, #e3e6ea));
        border-radius: 16px; box-shadow: var(--dsw-shadow-lv1, 0 1px 2px #0000000a); min-width: 0; }
      .me-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f4); flex-wrap: wrap; }
      .me-card-head h2 { margin: 0; font-size: 13px; font-weight: 680; letter-spacing: -.01em; }
      .me-card-head .me-sub { margin: 3px 0 0; font-size: 11px; color: var(--dsw-alias-label-secondary, #5c6570); font-weight: 400; }
      .me-card-body { padding: 14px 16px; }
      .me-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .me-row-end { justify-content: flex-end; }
      .me-stack { display: grid; gap: 10px; }
      .me-btn { appearance: none; font: inherit; font-size: 12.5px; font-weight: 600; height: 33px; padding: 0 12px; border-radius: 9px; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; transition: background .14s, border-color .14s, color .14s;
        border: .5px solid var(--dsw-alias-border-l3, #d1d5db); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1f2328); }
      .me-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #2631480f); }
      .me-btn:disabled { opacity: .5; cursor: not-allowed; }
      .me-btn-primary { background: var(--dsw-alias-button-primary-fill, #111827); color: var(--dsw-alias-label-primary-foreground, #fff); border-color: transparent; }
      .me-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #000); }
      .me-btn-brand { background: var(--dsw-alias-brand-primary, #2f6fed); color: #fff; border-color: transparent; }
      .me-btn-brand:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #2f6fed) 86%, #000); }
      .me-btn-ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary, #5c6570); }
      .me-btn-danger { color: var(--dsw-alias-state-error-primary, #dc2626); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 32%, transparent); background: transparent; }
      .me-btn-sm { height: 28px; padding: 0 9px; font-size: 11.5px; }
      .me-field { display: grid; gap: 5px; }
      .me-field > label { font-size: 11px; font-weight: 650; color: var(--dsw-alias-label-secondary, #5c6570); }
      .me-input, .me-select, .me-textarea { width: 100%; font: inherit; font-size: 12.5px; color: var(--dsw-alias-label-primary, #1f2328); background: var(--dsw-alias-bg-layer-1, #fff);
        border: 1px solid var(--dsw-alias-border-l2, #d1d5db); border-radius: 8px; padding: 7px 9px; outline: none; }
      .me-input:focus, .me-select:focus, .me-textarea:focus { border-color: var(--dsw-alias-brand-primary, #2f6fed); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #2f6fed) 15%, transparent); }
      .me-textarea { min-height: 74px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.5; }
      .me-badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; font-size: 10.5px; font-weight: 650; border: 1px solid transparent; white-space: nowrap; }
      .me-badge-neutral { background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: var(--dsw-alias-label-secondary, #5c6570); }
      .me-badge-brand { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #2f6fed) 10%, transparent); color: var(--dsw-alias-brand-primary, #2f6fed); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #2f6fed) 22%, transparent); }
      .me-badge-success { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 10%, transparent); color: var(--dsw-alias-state-success-primary, #15803d); }
      .me-badge-warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b45309) 12%, transparent); color: var(--dsw-alias-state-warn-primary, #b45309); }
      .me-badge-danger { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 10%, transparent); color: var(--dsw-alias-state-error-primary, #dc2626); }
      .me-table-wrap { overflow: auto; max-height: 560px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, #eef0f4); }
      table.me-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .me-table th { position: sticky; top: 0; white-space: nowrap; background: var(--dsw-alias-bg-layer-2, #f6f7f9); text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em;
        color: var(--dsw-alias-label-secondary, #5c6570); padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f4); font-weight: 700; z-index: 1; }
      .me-table td { padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #f2f3f5); vertical-align: top; }
      .me-table tr:hover td { background: var(--dsw-alias-interactive-bg-hover, #26314808); }
      .me-table td.me-num { font-variant-numeric: tabular-nums; text-align: right; }
      .me-clickable { cursor: pointer; }
      .me-title-cell { font-weight: 600; }
      .me-muted { color: var(--dsw-alias-label-secondary, #5c6570); }
      .me-dim { color: var(--dsw-alias-label-tertiary, #8b93a1); font-size: 11px; }
      .me-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
      .me-empty { padding: 26px 16px; text-align: center; color: var(--dsw-alias-label-tertiary, #8b93a1); font-size: 12px; }
      .me-progress { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #eef0f4); overflow: hidden; }
      .me-progress > span { display: block; height: 100%; background: var(--dsw-alias-brand-primary, #2f6fed); border-radius: inherit; transition: width .3s ease; }
      .me-stat { display: grid; gap: 3px; padding: 11px 13px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, #eef0f4); background: var(--dsw-alias-bg-layer-1, #fff); }
      .me-stat span { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--dsw-alias-label-tertiary, #8b93a1); font-weight: 700; }
      .me-stat b { font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
      .me-stat small { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #5c6570); }
      .me-option { display: flex; gap: 9px; padding: 9px 11px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, #eef0f4); background: var(--dsw-alias-bg-layer-1, #fff); align-items: flex-start; }
      .me-option.correct { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 6%, transparent); }
      .me-option .me-key { flex: none; width: 22px; height: 22px; border-radius: 7px; display: grid; place-items: center; font-size: 11px; font-weight: 800;
        background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: var(--dsw-alias-label-secondary, #5c6570); }
      .me-option.correct .me-key { background: var(--dsw-alias-state-success-primary, #16a34a); color: #fff; }
      .me-kv { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 6px 12px; font-size: 12px; }
      .me-kv dt { color: var(--dsw-alias-label-secondary, #5c6570); font-size: 11px; }
      .me-kv dd { margin: 0; word-break: break-word; }
      .me-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-primary, #1f2328); cursor: pointer; }
      .me-toggle { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; cursor: pointer; color: var(--dsw-alias-label-secondary, #5c6570); }
      .me-modal-backdrop { position: fixed; inset: 0; background: #0b122040; display: grid; place-items: center; z-index: 60; padding: 24px; }
      .me-modal { width: min(920px, 100%); max-height: 86vh; overflow: auto; background: var(--dsw-alias-bg-layer-1, #fff); border-radius: 16px;
        border: .5px solid var(--dsw-alias-border-l3, #e3e6ea); box-shadow: var(--dsw-shadow-lv2, 0 18px 44px #00000026); }
      .me-modal-head { position: sticky; top: 0; background: inherit; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f4); z-index: 2; }
      .me-modal-body { padding: 16px 18px 20px; display: grid; gap: 14px; }
      .me-toast { position: fixed; right: 22px; bottom: 22px; z-index: 80; padding: 11px 15px; border-radius: 11px; font-size: 12.5px;
        background: var(--dsw-alias-label-primary, #1f2328); color: var(--dsw-alias-bg-layer-1, #fff); box-shadow: var(--dsw-shadow-lv2, 0 12px 30px #0003); max-width: 420px; }
      .me-toast.error { background: var(--dsw-alias-state-error-primary, #dc2626); color: #fff; }
      .me-toast.success { background: var(--dsw-alias-state-success-primary, #16a34a); color: #fff; }
      .me-bar-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) 62px; gap: 10px; align-items: center; font-size: 11.5px; }
      .me-bar { height: 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #eef0f4); overflow: hidden; }
      .me-bar > span { display: block; height: 100%; background: var(--dsw-alias-brand-primary, #2f6fed); }
      .me-scroll { max-height: 420px; overflow: auto; display: grid; gap: 8px; }
      .me-list-row { display: flex; gap: 10px; align-items: center; justify-content: space-between; padding: 9px 11px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, #eef0f4); }
      .me-list-row.selected { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #2f6fed) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #2f6fed) 5%, transparent); }
      .me-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
      @media (max-width: 860px) { .me-split { grid-template-columns: 1fr; } }
      .me-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8b93a1); line-height: 1.55; }
      .me-warn { display: flex; gap: 8px; padding: 9px 11px; border-radius: 10px; font-size: 11.5px; line-height: 1.5;
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b45309) 9%, transparent); color: var(--dsw-alias-state-warn-primary, #b45309); }
      .me-actions { display: flex; gap: 6px; flex-wrap: wrap; }
      .me-pill { font-size: 10.5px; padding: 1px 7px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: var(--dsw-alias-label-secondary, #5c6570); }
    `;

    function installStyle() {
      const id = 'dsh-plugin-evalforge/style';
      if (document.querySelector(`style[data-plugin-style="${id}"]`)) return () => {};
      const style = document.createElement('style');
      style.dataset.pluginStyle = id;
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => style.remove();
    }

    /* ------------------------------ primitives ---------------------------- */

    function Btn({ variant = 'secondary', size, className, children, ...rest }) {
      return h('button', {
        type: 'button',
        className: cx('me-btn', variant !== 'secondary' && `me-btn-${variant}`, size === 'sm' && 'me-btn-sm', className),
        ...rest,
      }, children);
    }

    function Badge({ tone = 'neutral', children }) {
      return h('span', { className: `me-badge me-badge-${tone}` }, children);
    }

    function Field({ label, hint, children }) {
      return h('div', { className: 'me-field' },
        label ? h('label', null, label) : null,
        children,
        hint ? h('span', { className: 'me-hint' }, hint) : null);
    }

    function Card({ title, subtitle, actions, children, className }) {
      return h('section', { className: cx('me-card', className) },
        title || actions ? h('div', { className: 'me-card-head' },
          h('div', null, h('h2', null, title), subtitle ? h('p', { className: 'me-sub' }, subtitle) : null),
          actions ? h('div', { className: 'me-actions' }, actions) : null) : null,
        h('div', { className: 'me-card-body' }, children));
    }

    function Stat({ label, value, hint }) {
      return h('div', { className: 'me-stat' }, h('span', null, label), h('b', null, value), hint ? h('small', null, hint) : null);
    }

    function Progress({ value, label }) {
      return h('div', { className: 'me-stack', style: { gap: '5px' } },
        label ? h('div', { className: 'me-row', style: { justifyContent: 'space-between' } },
          h('span', { className: 'me-dim' }, label),
          h('span', { className: 'me-dim me-mono' }, `${Math.round(value || 0)}%`)) : null,
        h('div', { className: 'me-progress' }, h('span', { style: { width: `${Math.max(0, Math.min(100, value || 0))}%` } })));
    }

    function Modal({ title, subtitle, onClose, children, width }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onClose]);
      return h('div', { className: 'me-modal-backdrop', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('div', { className: 'me-modal', style: width ? { width } : undefined, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('div', { className: 'me-modal-head' },
            h('div', null, h('h2', { style: { margin: 0, fontSize: '14px' } }, title), subtitle ? h('p', { className: 'me-sub', style: { margin: '3px 0 0', fontSize: '11px', color: 'inherit', opacity: .7 } }, subtitle) : null),
            h(Btn, { variant: 'ghost', size: 'sm', onClick: onClose }, '✕')),
          h('div', { className: 'me-modal-body' }, children)));
    }

    function Empty({ children }) {
      return h('div', { className: 'me-empty' }, children);
    }

    function Toast({ toast }) {
      if (!toast) return null;
      return h('div', { className: cx('me-toast', toast.tone) }, toast.text);
    }

    /* ------------------------------- page -------------------------------- */

    function EvalForgePage(props) {
      const locale = props.locale;
      const lang = useLang(locale);
      const L = (zhText, enText) => (lang === 'zh' ? zhText : enText);

      const [tab, setTab] = useState('data');
      const [boot, setBoot] = useState(null);
      const [fatal, setFatal] = useState('');
      const [busy, setBusy] = useState('');
      const [toast, setToast] = useState(null);
      const toastTimer = useRef(null);
      const showToast = useCallback((text, tone = 'info') => {
        setToast({ text, tone });
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 4500);
      }, []);
      useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

      // data explorer
      const [filters, setFilters] = useState({ condition: 'Type 2 Diabetes', phases: ['PHASE2', 'PHASE3'], studyTypes: ['INTERVENTIONAL'], statuses: [], maxRecords: 60 });
      const [trials, setTrials] = useState([]);
      const [trialQuery, setTrialQuery] = useState('');
      const [selected, setSelected] = useState(new Set());
      const [detail, setDetail] = useState(null);
      const [batch, setBatch] = useState(null);

      // builder
      const [genConfig, setGenConfig] = useState({ task_types: ['endpoint_selection', 'eligibility_criteria_matching'], per_task: 10, seed: 42, include_experimental: false });
      const [benchmark, setBenchmark] = useState(null);
      const [quality, setQuality] = useState(null);
      const [activeItem, setActiveItem] = useState(null);
      const [editing, setEditing] = useState(null);

      // evaluation
      const [benchmarks, setBenchmarks] = useState([]);
      const [runBenchmarkId, setRunBenchmarkId] = useState('');
      const [modelConfig, setModelConfig] = useState(null);
      const [nativeModels, setNativeModels] = useState([]);
      const [selectedModels, setSelectedModels] = useState(new Set());
      const [runSettings, setRunSettings] = useState({ temperature: 0.2, maxTokens: 4096, concurrency: 3, retries: 2, repeats: 1, shuffle_options: false, include_needs_review: false, include_experimental: false });
      const [run, setRun] = useState(null);
      const [runs, setRuns] = useState([]);
      const [meta, setMeta] = useState(null);
      const [cellDetail, setCellDetail] = useState(null);
      const [newModel, setNewModel] = useState({ kind: 'openai', label: '', baseUrl: 'https://api.deepseek.com', model: '', apiKeyRef: 'EVALFORGE_CUSTOM_API_KEY' });
      const [keyDraft, setKeyDraft] = useState('');

      // meta filters
      const [metaFilter, setMetaFilter] = useState({ task_type: '', quality: 'all', model: '' });
      const [difficultySort, setDifficultySort] = useState('difficult');
      // modelId -> 'high' | 'low' | '' ; declared before the run, used for formal discrimination
      const [groups, setGroups] = useState({});

      const loadTrials = useCallback(async (search) => {
        const params = new URLSearchParams();
        if (search) params.set('search', search);
        params.set('limit', '500');
        const data = await api(`trials?${params.toString()}`);
        setTrials(data.trials || []);
        return data;
      }, []);

      const loadModels = useCallback(async () => {
        const data = await api('models');
        setModelConfig(data);
        setNativeModels(data.native_models || []);
        const enabled = (data.models || []).filter((model) => model.enabled !== false).map((model) => model.id);
        setSelectedModels((prev) => (prev.size ? prev : new Set(enabled)));
        return data;
      }, []);

      const loadBenchmarks = useCallback(async () => {
        const data = await api('benchmarks');
        setBenchmarks(data.benchmarks || []);
        return data.benchmarks || [];
      }, []);

      const loadRuns = useCallback(async () => {
        const data = await api('runs?limit=30');
        setRuns(data.runs || []);
        return data.runs || [];
      }, []);

      const loadBenchmark = useCallback(async (id) => {
        const data = await api(`benchmark?id=${encodeURIComponent(id)}`);
        setBenchmark(data.benchmark);
        setQuality(data.quality);
        setActiveItem((data.benchmark.items || [])[0] || null);
        return data.benchmark;
      }, []);

      const bootstrap = useCallback(async () => {
        setFatal('');
        try {
          const data = await api('bootstrap');
          setBoot(data);
          setBenchmarks(data.benchmarks || []);
          setRuns(data.runs || []);
          setNativeModels(data.native_models || []);
          setModelConfig({
            models: (data.config && data.config.models) || [],
            settings: (data.config && data.config.settings) || {},
            native_models: data.native_models || [],
            native_available: data.native_available === true,
          });
          const enabled = ((data.config && data.config.models) || []).filter((model) => model.enabled !== false).map((model) => model.id);
          setSelectedModels(new Set(enabled));
          setRunSettings((prev) => ({ ...prev, ...((data.config && data.config.settings) || {}) }));
          await loadTrials('');
          if (data.benchmarks && data.benchmarks.length) {
            setRunBenchmarkId(data.benchmarks[0].id);
            await loadBenchmark(data.benchmarks[0].id);
          }
          if (data.runs && data.runs.length) {
            const first = data.runs[0];
            const detailRun = await api(`run?run_id=${encodeURIComponent(first.id)}`);
            setRun(detailRun.run);
            setRunBenchmarkId(detailRun.run.benchmark_id);
            if (detailRun.run.status === 'completed' || detailRun.run.status === 'completed_with_errors') {
              const metaData = await api(`meta?run_id=${encodeURIComponent(first.id)}`);
              setMeta(metaData.meta);
            }
          }
        } catch (err) {
          setFatal(err.message);
        }
      }, [loadTrials, loadBenchmark]);

      useEffect(() => { bootstrap(); }, [bootstrap]);

      // Poll an active run.
      useEffect(() => {
        if (!run || !ACTIVE.has(run.status)) return undefined;
        const timer = setInterval(async () => {
          try {
            const data = await api(`run?run_id=${encodeURIComponent(run.id)}`);
            setRun(data.run);
            if (!ACTIVE.has(data.run.status)) {
              const metaData = await api(`meta?run_id=${encodeURIComponent(data.run.id)}`);
              setMeta(metaData.meta);
              await loadRuns();
            }
          } catch {
            // transient polling failure
          }
        }, 1800);
        return () => clearInterval(timer);
      }, [run, loadRuns]);

      const guard = useCallback(async (name, fn) => {
        setBusy(name);
        try {
          return await fn();
        } catch (err) {
          showToast(err.message || String(err), 'error');
          return null;
        } finally {
          setBusy('');
        }
      }, [showToast]);

      const toggle = (setter, value) => {
        setter((prev) => {
          const next = new Set(prev);
          if (next.has(value)) next.delete(value);
          else next.add(value);
          return next;
        });
      };

      /* ------------------------------ actions ----------------------------- */

      const doFetch = () => guard('fetch', async () => {
        const payload = {
          condition: filters.condition,
          phases: filters.phases,
          studyTypes: filters.studyTypes,
          statuses: filters.statuses,
          maxRecords: Number(filters.maxRecords),
        };
        const data = await api('trials/fetch', { method: 'POST', body: payload });
        setBatch(data);
        await loadTrials(trialQuery);
        showToast(L(`已抓取 ${data.trials.length} 条真实试验记录`, `Fetched ${data.trials.length} real trial records`), 'success');
        const refreshed = await api('bootstrap');
        setBoot(refreshed);
      });

      const doGenerate = () => guard('generate', async () => {
        const payload = {
          nct_ids: selected.size ? [...selected] : undefined,
          task_types: genConfig.task_types,
          per_task: Number(genConfig.per_task),
          seed: Number(genConfig.seed),
          include_experimental: genConfig.include_experimental,
        };
        const data = await api('benchmark/generate', { method: 'POST', body: payload });
        setBenchmark(data.benchmark);
        setActiveItem((data.benchmark.items || [])[0] || null);
        const q = await api(`benchmark?id=${encodeURIComponent(data.benchmark.id)}`);
        setQuality(q.quality);
        await loadBenchmarks();
        setRunBenchmarkId(data.benchmark.id);
        setTab('builder');
        showToast(L(`已生成 ${data.benchmark.items.length} 道题（有效 ${data.stats.valid}）`, `Generated ${data.benchmark.items.length} items (${data.stats.valid} valid)`), 'success');
      });

      const doSaveItem = (payload) => guard('saveItem', async () => {
        await api('item/update', { method: 'POST', body: payload });
        await loadBenchmark(benchmark.id);
        setEditing(null);
        showToast(L('已保存题目修改', 'Item saved'), 'success');
      });

      const doDeleteItem = (itemId) => guard('deleteItem', async () => {
        await api('item/delete', { method: 'POST', body: { benchmark_id: benchmark.id, item_id: itemId } });
        await loadBenchmark(benchmark.id);
        showToast(L('已删除题目', 'Item deleted'), 'success');
      });

      const doRun = () => guard('run', async () => {
        if (!runBenchmarkId) throw new Error(L('请先选择题库', 'Select a benchmark first'));
        const models = (modelConfig?.models || []).filter((model) => selectedModels.has(model.id));
        if (!models.length) throw new Error(L('请至少选择一个模型', 'Select at least one model'));
        const runPayload = {
          benchmark_id: runBenchmarkId,
          model_ids: models.map((model) => model.id),
          settings: runSettings,
          capability_groups: capabilityGroups(),
        };
        const data = await api('runs', { method: 'POST', body: runPayload });
        setRun(data.run);
        setMeta(null);
        await loadRuns();
        setTab('eval');
        showToast(L('评测已启动', 'Evaluation started'), 'success');
      });

      const doCancel = () => guard('cancel', async () => {
        if (!run) return;
        const data = await api('run/cancel', { method: 'POST', body: { run_id: run.id } });
        setRun(data.run);
      });

      const doResume = () => guard('resume', async () => {
        if (!run) return;
        const data = await api('run/resume', { method: 'POST', body: { run_id: run.id, retry_failed: true } });
        setRun(data.run);
      });

      const doMeta = () => guard('meta', async () => {
        if (!run) throw new Error(L('暂无运行记录', 'No run selected'));
        const data = await api(`meta?run_id=${encodeURIComponent(run.id)}`);
        setMeta(data.meta);
        setTab('meta');
      });

      const doExport = (format) => guard(`export-${format}`, async () => {
        if (!run) throw new Error(L('暂无运行记录', 'No run selected'));
        await download(`export?run_id=${encodeURIComponent(run.id)}&format=${format}`, `evalforge.${format}`);
        showToast(L(`${format} 已开始下载`, `${format} download started`), 'success');
      });

      const saveModelConfig = (models, settings) => guard('saveModels', async () => {
        await api('models/save', { method: 'POST', body: { models, settings } });
        await loadModels();
        showToast(L('模型配置已保存', 'Model configuration saved'), 'success');
      });

      const saveKey = (ref) => guard('saveKey', async () => {
        if (!keyDraft.trim()) throw new Error(L('请输入 API Key', 'Enter an API key'));
        const data = await api('keys', { method: 'POST', body: { ref, key: keyDraft.trim(), remember: true } });
        setKeyDraft('');
        await loadModels();
        showToast(data.warning || L('密钥已保存', 'Key saved'), data.warning ? 'info' : 'success');
      });

      const testModel = (modelId) => guard('test', async () => {
        const data = await api('models/test', { method: 'POST', body: { model_id: modelId } });
        showToast(L(`连接成功：${data.text}（${data.latency_ms}ms）`, `Connected: ${data.text} (${data.latency_ms}ms)`), 'success');
      });

      function capabilityGroups() {
        const high = Object.entries(groups).filter(([, value]) => value === 'high').map(([id]) => id);
        const low = Object.entries(groups).filter(([, value]) => value === 'low').map(([id]) => id);
        if (!high.length || !low.length) return null;
        return { high, low };
      }

      /* ------------------------------- render ----------------------------- */

      const configuredModels = (modelConfig?.models) || [];
      const corpus = (boot && boot.corpus) || { trials: 0 };
      const itemList = (benchmark && benchmark.items) || [];
      const visibleTrials = useMemo(() => {
        const phrase = trialQuery.trim().toLowerCase();
        if (!phrase) return trials;
        return trials.filter((trial) => `${trial.nct_id} ${trial.brief_title} ${(trial.conditions || []).join(' ')}`.toLowerCase().includes(phrase));
      }, [trials, trialQuery]);

      const filteredItems = useMemo(() => itemList.filter((item) => {
        if (metaFilter.task_type && item.task_type !== metaFilter.task_type) return false;
        if (metaFilter.quality !== 'all' && item.quality.status !== metaFilter.quality) return false;
        return true;
      }), [itemList, metaFilter.task_type, metaFilter.quality]);

      const totalCells = run ? (run.progress && run.progress.total) || 0 : 0;
      const percent = run && run.progress ? run.progress.percent : 0;

      if (fatal) {
        return h('div', { className: 'me-root' }, h(Card, { title: 'EvalForge' },
          h('div', { className: 'me-warn' }, h('span', null, '⚠'), h('span', null, `${L('插件后端不可用', 'Plugin backend unavailable')}: ${fatal}`))));
      }
      if (!boot) {
        return h('div', { className: 'me-root' }, h(Card, { title: 'EvalForge' }, h(Empty, null, L('正在加载…', 'Loading…'))));
      }

      const header = h('div', { className: 'me-top' },
        h('div', { className: 'me-brand' },
          h('div', { className: 'me-brand-mark' }, 'EF'),
          h('div', null,
            h('h1', null, 'EvalForge'),
            h('p', null, L('临床试验数据 → 可追溯题库 → 多模型评测 → Meta-Eval', 'Clinical trials → verifiable benchmark → multi-model evaluation → meta-eval')))),
        h('div', { className: 'me-chips' },
          h('span', { className: 'me-chip' }, L('语料', 'Corpus'), h('b', null, corpus.trials || 0)),
          h('span', { className: 'me-chip' }, L('题库', 'Benchmarks'), h('b', null, (benchmarks || []).length)),
          h('span', { className: 'me-chip' }, L('运行', 'Runs'), h('b', null, (runs || []).length)),
          h('span', { className: 'me-chip' }, L('原生模型', 'Native models'), h('b', null, nativeModels.filter((model) => model.model).length)),
          h('span', { className: 'me-chip' }, 'v' + (boot.plugin ? boot.plugin.version : ''))));

      const tabs = [['data', L('数据采集', 'Data Explorer')], ['builder', L('题库构建', 'Benchmark Builder')], ['eval', L('模型评测', 'Evaluation')], ['meta', L('Meta-Eval', 'Meta-Eval')], ['reports', L('报告导出', 'Reports')]];

      const tabBar = h('div', { className: 'me-tabs', role: 'tablist' },
        tabs.map(([key, label]) => h('button', {
          key,
          type: 'button',
          role: 'tab',
          'aria-selected': tab === key,
          className: cx('me-tab', tab === key && 'active'),
          onClick: () => setTab(key),
        }, label)));

      return h('div', { className: 'me-root' },
        header,
        tabBar,
        tab === 'data' ? renderData() : null,
        tab === 'builder' ? renderBuilder() : null,
        tab === 'eval' ? renderEval() : null,
        tab === 'meta' ? renderMeta() : null,
        tab === 'reports' ? renderReports() : null,
        detail ? renderTrialModal() : null,
        editing ? renderEditModal() : null,
        cellDetail ? renderCellModal() : null,
        h(Toast, { toast }));

      const openTrial = useCallback(async (nctId) => {
        try {
          const data = await api(`trial?nct_id=${encodeURIComponent(nctId)}`);
          setDetail({ trial: data.trial });
        } catch (err) {
          showToast(err.message || String(err), 'error');
        }
      }, [showToast]);

      /* ------------------------------ data tab ---------------------------- */

      function renderData() {
        return h('div', { className: 'me-grid' },
          h('div', { className: 'me-grid me-grid-3' },
            h(Stat, { label: L('本地试验记录', 'Trials stored'), value: corpus.trials || 0, hint: corpus.updated_at ? fmtDate(corpus.updated_at) : '' }),
            h(Stat, { label: L('含主要终点', 'With primary outcomes'), value: corpus.with_outcomes || 0 }),
            h(Stat, { label: L('含纳排标准', 'With eligibility'), value: corpus.with_eligibility || 0 }),
            h(Stat, { label: L('可判定完成状态', 'Terminal status'), value: corpus.completed_or_stopped || 0 })),
          h('div', { className: 'me-grid me-grid-2' },
            h(Card, { title: L('ClinicalTrials.gov 检索', 'ClinicalTrials.gov search'), subtitle: L('API v2 · 公开注册数据 · 无需患者隐私数据', 'API v2 · public registry data') },
              h('div', { className: 'me-stack' },
                h(Field, { label: L('疾病关键词', 'Condition keyword') },
                  h('input', { className: 'me-input', value: filters.condition, placeholder: 'Type 2 Diabetes / Lung Cancer', onChange: (e) => setFilters({ ...filters, condition: e.target.value }) })),
                h(Field, { label: L('试验阶段', 'Phase') },
                  h('div', { className: 'me-row' }, ['PHASE1', 'PHASE2', 'PHASE3', 'PHASE4', 'NA'].map((phase) => h('label', { key: phase, className: 'me-check' },
                    h('input', {
                      type: 'checkbox',
                      checked: filters.phases.includes(phase),
                      onChange: () => setFilters({ ...filters, phases: filters.phases.includes(phase) ? filters.phases.filter((value) => value !== phase) : [...filters.phases, phase] }),
                    }), phase.replace('PHASE', 'P'))))),
                h(Field, { label: L('研究类型', 'Study type') },
                  h('div', { className: 'me-row' }, ['INTERVENTIONAL', 'OBSERVATIONAL'].map((type) => h('label', { key: type, className: 'me-check' },
                    h('input', {
                      type: 'checkbox',
                      checked: filters.studyTypes.includes(type),
                      onChange: () => setFilters({ ...filters, studyTypes: filters.studyTypes.includes(type) ? filters.studyTypes.filter((value) => value !== type) : [...filters.studyTypes, type] }),
                    }), type === 'INTERVENTIONAL' ? L('干预性', 'Interventional') : L('观察性', 'Observational'))))),
                h(Field, { label: L('试验状态', 'Overall status'), hint: L('留空表示不限；完成预测任务需要 COMPLETED/TERMINATED 等终态', 'Leave empty for all; completion task needs terminal statuses') },
                  h('div', { className: 'me-row' }, ['COMPLETED', 'TERMINATED', 'RECRUITING', 'ACTIVE_NOT_RECRUITING'].map((status) => h('label', { key: status, className: 'me-check' },
                    h('input', {
                      type: 'checkbox',
                      checked: filters.statuses.includes(status),
                      onChange: () => setFilters({ ...filters, statuses: filters.statuses.includes(status) ? filters.statuses.filter((value) => value !== status) : [...filters.statuses, status] }),
                    }), status.replace(/_/g, ' ').toLowerCase()))))),
                h('div', { className: 'me-split' },
                  h(Field, { label: L('最大抓取数量', 'Max records') },
                    h('input', { className: 'me-input', type: 'number', min: 1, max: 1000, value: filters.maxRecords, onChange: (e) => setFilters({ ...filters, maxRecords: e.target.value }) })),
                  h(Field, { label: L('已选择', 'Selected') }, h('div', { style: { paddingTop: '7px' } }, h('b', null, selected.size), h('span', { className: 'me-dim' }, ` / ${trials.length}`)))),
                h(Btn, { variant: 'brand', onClick: doFetch, disabled: busy === 'fetch' }, busy === 'fetch' ? L('抓取中…', 'Fetching…') : L('开始抓取', 'Fetch trials')),
                batch ? h('div', { className: 'me-hint' },
                  `${L('本次请求', 'Requests')}: ${batch.batch.stats.requests} · ${L('重试', 'retries')}: ${batch.batch.stats.retries} · ${L('新增', 'added')}: ${batch.ingested.added} · ${L('注册库匹配总数', 'matches in registry')}: ${batch.batch.stats.available}`) : null,
                h('div', { className: 'me-hint' }, L('每条记录都会保存原始 JSON、来源 URL、抓取时间、记录版本与缺失字段标记。', 'Each record stores the raw JSON, source URL, fetch time, record version and missing-field flags.')))),
            h(Card, {
              title: L('已抓取试验', 'Stored trials'),
              subtitle: `${visibleTrials.length} / ${trials.length}`,
              actions: h('div', { className: 'me-row' },
                h('input', { className: 'me-input', style: { width: '190px' }, placeholder: L('搜索 NCT / 标题', 'Search NCT / title'), value: trialQuery, onChange: (e) => setTrialQuery(e.target.value) }),
                h(Btn, { size: 'sm', onClick: () => setSelected(new Set(visibleTrials.map((trial) => trial.nct_id))) }, L('全选', 'Select all')),
                h(Btn, { size: 'sm', variant: 'ghost', onClick: () => setSelected(new Set()) }, L('清空', 'Clear')),
                h(Btn, { size: 'sm', variant: 'brand', onClick: doGenerate, disabled: busy === 'generate' }, L('用所选生成题库', 'Build from selected'))),
            },
              visibleTrials.length === 0
                ? h(Empty, null, L('还没有数据，先在上方抓取。', 'No data yet — fetch trials first.'))
                : renderTrialsTable(visibleTrials)));
      }

      function renderTrialsTable(list) {
        const head = h('thead', null, h('tr', null,
          h('th', { style: { width: '34px' } }),
          h('th', null, 'NCT'),
          h('th', null, L('标题', 'Title')),
          h('th', null, L('阶段', 'Phase')),
          h('th', null, L('状态', 'Status')),
          h('th', null, L('终点', 'Outcomes')),
          h('th', null, L('缺失', 'Missing'))));

        const rows = list.map((trial) => {
          const checkbox = h('input', {
            type: 'checkbox',
            checked: selected.has(trial.nct_id),
            onClick: (event) => event.stopPropagation(),
            onChange: () => toggle(setSelected, trial.nct_id),
          });
          const link = h('a', {
            href: trial.source_url,
            target: '_blank',
            rel: 'noreferrer',
            onClick: (event) => event.stopPropagation(),
          }, trial.nct_id);
          const statusTone = trial.overall_status === 'COMPLETED' ? 'success' : trial.overall_status === 'TERMINATED' ? 'warn' : 'neutral';
          const missing = trial.missing_fields.length
            ? h(Badge, { tone: 'warn' }, trial.missing_fields.length)
            : h('span', { className: 'me-dim' }, '0');
          return h('tr', { key: trial.nct_id, className: 'me-clickable', onClick: () => openTrial(trial.nct_id) },
            h('td', null, checkbox),
            h('td', { className: 'me-mono' }, link),
            h('td', { className: 'me-title-cell' }, trial.brief_title),
            h('td', null, trial.phase),
            h('td', null, h(Badge, { tone: statusTone }, trial.overall_status || '—')),
            h('td', { className: 'me-num' }, trial.has_primary_outcomes ? '✓' : '—'),
            h('td', null, missing));
        });

        return h('div', { className: 'me-table-wrap' },
          h('table', { className: 'me-table' }, head, h('tbody', null, rows)));
      }

      function renderTrialModal() {
        const trial = detail.trial || detail;
        return h(Modal, {
          title: `${trial.nct_id} · ${trial.brief_title}`,
          subtitle: trial.source ? trial.source.source_url : '',
          onClose: () => setDetail(null),
          width: '980px',
        },
          h('div', { className: 'me-row' },
            h(Badge, { tone: 'brand' }, trial.phase || 'NA'),
            h(Badge, { tone: 'neutral' }, trial.study_type || '—'),
            h(Badge, { tone: trial.overall_status === 'COMPLETED' ? 'success' : 'warn' }, trial.overall_status || '—'),
            h(Badge, { tone: 'neutral' }, `${L('入组', 'Enrollment')}: ${trial.enrollment?.count ?? '—'}`),
            h('a', { className: 'me-hint', href: trial.source?.source_url, target: '_blank', rel: 'noreferrer' }, L('打开官方页面 ↗', 'Open registry page ↗'))),
          h('dl', { className: 'me-kv' },
            h('dt', null, L('研究目的', 'Brief summary')), h('dd', null, trial.brief_summary || '—'),
            h('dt', null, L('疾病', 'Conditions')), h('dd', null, (trial.conditions || []).join(', ') || '—'),
            h('dt', null, L('干预', 'Interventions')), h('dd', null, (trial.interventions || []).map((item) => `${item.type}: ${item.name}`).join('; ') || '—'),
            h('dt', null, L('主要终点', 'Primary outcomes')), h('dd', null,
              (trial.primary_outcomes || []).length
                ? h('ul', { style: { margin: 0, paddingLeft: '18px' } }, trial.primary_outcomes.map((outcome, index) => h('li', { key: index }, `${outcome.measure}${outcome.time_frame ? ` (${outcome.time_frame})` : ''}`)))
                : '—'),
            h('dt', null, L('纳排标准', 'Eligibility')), h('dd', null, h('div', { className: 'me-mono', style: { maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap' } }, trial.eligibility_criteria || '—')),
            h('dt', null, L('抓取时间', 'Fetched at')), h('dd', null, fmtDate(trial.source?.fetched_at)),
            h('dt', null, L('记录版本', 'Record version')), h('dd', { className: 'me-mono' }, trial.record_version || '—'),
            h('dt', null, L('最后更新', 'Last update')), h('dd', null, trial.study_dates?.last_update_posted || '—'),
            h('dt', null, L('缺失字段', 'Missing fields')), h('dd', null, (trial.missing_fields || []).join(', ') || '—')));
      }

      /* ---------------------------- builder tab --------------------------- */

      function renderBuilder() {
        const stats = benchmark ? benchmark.stats : null;
        const byTask = stats ? stats.per_task : {};
        return h('div', { className: 'me-grid me-grid-2' },
          h(Card, { title: L('生成参数', 'Generation'), subtitle: L('规则抽取 GT + 确定性选项组装', 'Rule-based GT + deterministic option assembly') },
            h('div', { className: 'me-stack' },
              h(Field, { label: L('任务类型', 'Task types') },
                h('div', { className: 'me-stack' }, Object.keys(TASK_LABEL).map((task) => h('label', { key: task, className: 'me-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: genConfig.task_types.includes(task),
                    disabled: task === 'trial_completion_prediction' && !genConfig.include_experimental,
                    onChange: () => setGenConfig({
                      ...genConfig,
                      task_types: genConfig.task_types.includes(task) ? genConfig.task_types.filter((value) => value !== task) : [...genConfig.task_types, task],
                    }),
                  }),
                  TASK_LABEL[task][lang === 'zh' ? 0 : 1])))),
              h('label', { className: 'me-toggle' },
                h('input', { type: 'checkbox', checked: genConfig.include_experimental, onChange: (e) => setGenConfig({ ...genConfig, include_experimental: e.target.checked }) }),
                L('启用实验性任务（完成预测，标注 temporal_validation_required）', 'Enable experimental completion task')),
              h('div', { className: 'me-split' },
                h(Field, { label: L('每任务题数', 'Items per task') },
                  h('input', { className: 'me-input', type: 'number', min: 1, max: 100, value: genConfig.per_task, onChange: (e) => setGenConfig({ ...genConfig, per_task: e.target.value }) })),
                h(Field, { label: L('随机种子', 'Seed'), hint: L('同种子 → 同选项顺序', 'Same seed → same option order') },
                  h('input', { className: 'me-input', type: 'number', value: genConfig.seed, onChange: (e) => setGenConfig({ ...genConfig, seed: e.target.value }) }))),
              h('div', { className: 'me-hint' },
                L('将使用试验：', 'Trials used: '), h('b', null, selected.size || corpus.trials || 0),
                selected.size ? L('（使用勾选记录）', ' (using selection)') : L('（使用全部语料）', ' (using whole corpus)')),
              h(Btn, { variant: 'brand', onClick: doGenerate, disabled: busy === 'generate' }, busy === 'generate' ? L('生成中…', 'Generating…') : L('生成题库', 'Generate benchmark')),
              benchmark ? h('div', { className: 'me-stack' },
                h('div', { className: 'me-row' }, h('b', null, benchmark.name), h(Badge, { tone: 'brand' }, benchmark.id), h(Badge, { tone: 'neutral' }, `${benchmark.items.length} ${L('题', 'items')}`)),
                h('div', { className: 'me-hint me-mono' }, `hash ${String(benchmark.hash || '').slice(0, 16)}…`),
                h('div', { className: 'me-row' },
                  h(Btn, { size: 'sm', onClick: () => download(`benchmark/export?id=${encodeURIComponent(benchmark.id)}`, 'benchmark.jsonl') }, L('导出 JSONL', 'Export JSONL')),
                  h(Btn, { size: 'sm', onClick: () => { setRunBenchmarkId(benchmark.id); setTab('eval'); } }, L('去评测', 'Evaluate')),
                  h(Btn, { size: 'sm', variant: 'ghost', onClick: () => { setRunBenchmarkId(benchmark.id); doMeta(); } }, L('查看 Meta', 'Meta-Eval')))) :
                h('div', { className: 'me-hint' }, L('尚无题库。先抓取数据再生成。', 'No benchmark yet — fetch data and generate.')))),
          h('div', { className: 'me-stack' },
            quality ? h('div', { className: 'me-grid me-grid-3' },
              h(Stat, { label: L('有效题', 'Valid'), value: quality.by_task ? Object.values(quality.by_task).reduce((sum, row) => sum + row.valid, 0) : 0 }),
              h(Stat, { label: L('待复核', 'Needs review'), value: quality.by_task ? Object.values(quality.by_task).reduce((sum, row) => sum + row.needs_review, 0) : 0 }),
              h(Stat, { label: L('无效题', 'Invalid'), value: quality.by_task ? Object.values(quality.by_task).reduce((sum, row) => sum + row.invalid, 0) : 0 })) : null,
            h(Card, {
              title: L('题目列表', 'Items'),
              subtitle: itemList.length ? `${filteredItems.length} / ${itemList.length}` : '',
              actions: h('div', { className: 'me-row' },
                h('select', { className: 'me-select', style: { width: '150px' }, value: metaFilter.task_type, onChange: (e) => setMetaFilter({ ...metaFilter, task_type: e.target.value }) },
                  h('option', { value: '' }, L('全部任务', 'All tasks')),
                  Object.keys(TASK_LABEL).map((task) => h('option', { key: task, value: task }, TASK_LABEL[task][lang === 'zh' ? 0 : 1]))),
                h('select', { className: 'me-select', style: { width: '130px' }, value: metaFilter.quality, onChange: (e) => setMetaFilter({ ...metaFilter, quality: e.target.value }) },
                  h('option', { value: 'all' }, L('全部质量', 'All quality')),
                  h('option', { value: 'valid' }, L('有效', 'Valid')),
                  h('option', { value: 'needs_review' }, L('待复核', 'Needs review')),
                  h('option', { value: 'invalid' }, L('无效', 'Invalid'))))
            },
              itemList.length === 0 ? h(Empty, null, L('还没有题目。', 'No items yet.')) :
                h('div', { className: 'me-scroll' },
                  h('table', { className: 'me-table' },
                    h('thead', null, h('tr', null,
                      h('th', null, 'ID'),
                      h('th', null, L('任务', 'Task')),
                      h('th', null, L('来源', 'Source')),
                      h('th', null, L('质量', 'Quality')),
                      h('th', null, L('GT', 'GT')))),
                    h('tbody', null, filteredItems.map((item) => h('tr', { key: item.id, className: 'me-clickable', onClick: () => setActiveItem(item) },
                      h('td', { className: 'me-mono' }, item.id),
                      h('td', null, TASK_LABEL[item.task_type][lang === 'zh' ? 0 : 1]),
                      h('td', { className: 'me-mono' }, item.evidence.nct_id),
                      h('td', null, h(Badge, { tone: STATUS_TONE[item.quality.status] || 'neutral' }, item.quality.status)),
                      h('td', null, h('b', null, item.ground_truth.answer))))))),
            activeItem ? renderItemDetail(activeItem) : null)));
      }

      function renderItemDetail(item) {
        return h(Card, {
          title: `${item.id} · ${TASK_LABEL[item.task_type][lang === 'zh' ? 0 : 1]}`,
          subtitle: `${item.evidence.nct_id} · ${item.evidence.source_field}`,
          actions: h('div', { className: 'me-row' },
            h(Btn, { size: 'sm', onClick: () => setEditing(JSON.parse(JSON.stringify(item))) }, L('编辑', 'Edit')),
            h(Btn, { size: 'sm', variant: 'danger', onClick: () => doDeleteItem(item.id) }, L('删除', 'Delete'))),
        },
          h('div', { className: 'me-stack' },
            h('div', { className: 'me-mono', style: { whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: '12px' } }, item.query),
            h('div', { className: 'me-stack' }, Object.keys(item.options).map((label) => h('div', { key: label, className: cx('me-option', label === item.ground_truth.answer && 'correct') },
              h('span', { className: 'me-key' }, label),
              h('span', null, item.options[label])))),
            h('div', { className: 'me-row' },
              h(Badge, { tone: 'success' }, `${L('答案', 'Answer')} ${item.ground_truth.answer}`),
              h(Badge, { tone: 'brand' }, item.ground_truth.type),
              h(Badge, { tone: STATUS_TONE[item.quality.status] || 'neutral' }, item.quality.status),
              item.quality.temporal_validation_required ? h(Badge, { tone: 'warn' }, 'temporal_validation_required') : null,
              item.quality.synthetic_distractors ? h(Badge, { tone: 'warn' }, L('含合成干扰项', 'synthetic distractor')) : null),
            h('details', { open: true },
              h('summary', { className: 'me-hint' }, L('证据链与质量检查', 'Evidence chain and quality checks')),
              h('dl', { className: 'me-kv', style: { marginTop: '8px' } },
                h('dt', null, L('原始文本', 'Original text')), h('dd', { className: 'me-mono' }, item.evidence.original_text),
                h('dt', null, L('字段路径', 'Field path')), h('dd', { className: 'me-mono' }, item.evidence.field_path),
                h('dt', null, L('记录版本', 'Record version')), h('dd', { className: 'me-mono' }, item.evidence.record_version || '—'),
                h('dt', null, L('抓取时间', 'Fetched at')), h('dd', null, fmtDate(item.evidence.fetched_at)),
                h('dt', null, L('题目来源', 'Source URL')), h('dd', null, h('a', { href: item.evidence.source_url, target: '_blank', rel: 'noreferrer' }, item.evidence.source_url)),
                h('dt', null, L('干扰项来源', 'Distractor sources')), h('dd', null, (item.distractor_sources || []).map((source) => `${source.nct_id}${source.mutation ? ` (${source.mutation})` : ''}`).join(', ') || '—')),
              h('div', { className: 'me-row', style: { marginTop: '8px' } }, (item.quality.checks || []).map((check) => h(Badge, {
                key: check.rule,
                tone: check.status === 'pass' ? 'success' : check.status === 'warn' ? 'warn' : 'danger',
              }, `${check.rule}: ${check.status}`))))));
      }

      function renderEditModal() {
        return h(Modal, { title: L('编辑题目', 'Edit item'), subtitle: editing.id, onClose: () => setEditing(null), width: '860px' },
          h('div', { className: 'me-stack' },
            h(Field, { label: L('题干', 'Question') },
              h('textarea', { className: 'me-textarea', style: { minHeight: '150px' }, value: editing.query, onChange: (e) => setEditing({ ...editing, query: e.target.value }) })),
            Object.keys(editing.options).map((label) => h(Field, { key: label, label: `${L('选项', 'Option')} ${label}${label === editing.ground_truth.answer ? L('（正确答案）', ' (answer)') : ''}` },
              h('textarea', { className: 'me-textarea', value: editing.options[label], onChange: (e) => setEditing({ ...editing, options: { ...editing.options, [label]: e.target.value } }) }))),
            h('div', { className: 'me-row' },
              h(Field, { label: L('正确答案', 'Correct answer') },
                h('select', { className: 'me-select', value: editing.ground_truth.answer, onChange: (e) => setEditing({ ...editing, ground_truth: { ...editing.ground_truth, answer: e.target.value } }) },
                  Object.keys(editing.options).map((label) => h('option', { key: label, value: label }, label)))),
              h(Field, { label: L('质量状态', 'Quality status') },
                h('select', { className: 'me-select', value: editing.quality.status, onChange: (e) => setEditing({ ...editing, quality: { ...editing.quality, status: e.target.value } }) },
                  h('option', { value: 'valid' }, 'valid'),
                  h('option', { value: 'needs_review' }, 'needs_review'),
                  h('option', { value: 'invalid' }, 'invalid')))),
            h('div', { className: 'me-warn' }, L('编辑会改变题目内容，但证据链保持不变；请确认修改后仍然能从原始注册字段追溯。', 'Editing changes the item but not the evidence chain — make sure the answer stays traceable to the registry field.')),
            h('div', { className: 'me-row me-row-end' },
              h(Btn, { variant: 'ghost', onClick: () => setEditing(null) }, L('取消', 'Cancel')),
              h(Btn, { variant: 'brand', onClick: () => doSaveItem({ benchmark_id: benchmark.id, item_id: editing.id, query: editing.query, options: editing.options, answer: editing.ground_truth.answer, quality_status: editing.quality.status }) }, L('保存', 'Save')))));
      }

      /* ----------------------------- eval tab ------------------------------ */

      function renderEval() {
        const catalog = nativeModels.filter((model) => model.model);
        const grouped = {};
        for (const model of catalog) {
          grouped[model.provider] = grouped[model.provider] || { label: model.provider_label, models: [] };
          grouped[model.provider].models.push(model);
        }
        return h('div', { className: 'me-grid' },
          h('div', { className: 'me-grid me-grid-2' },
            h(Card, { title: L('运行配置', 'Run configuration'), subtitle: L('同一提示词、同一选项、同一参数', 'Same prompt, options and settings for every model') },
              h('div', { className: 'me-stack' },
                h(Field, { label: L('题库', 'Benchmark') },
                  h('select', { className: 'me-select', value: runBenchmarkId, onChange: (e) => setRunBenchmarkId(e.target.value) },
                    h('option', { value: '' }, L('选择题库…', 'Select…')),
                    (benchmarks || []).map((entry) => h('option', { key: entry.id, value: entry.id }, `${entry.name} (${entry.items})`)))),
                h(Field, { label: L('模型', 'Models'), hint: L('来自 Harness 已配置的 Provider，也可在下方添加自定义端点', 'From the Harness provider catalog; custom endpoints can be added below') },
                  h('div', { className: 'me-scroll', style: { maxHeight: '220px' } },
                    Object.keys(grouped).length === 0 ? h(Empty, null, L('未发现原生模型，请在下方添加自定义端点。', 'No native models found — add a custom endpoint below.')) :
                      Object.keys(grouped).map((provider) => h('div', { key: provider, className: 'me-stack', style: { gap: '4px' } },
                        h('div', { className: 'me-hint', style: { textTransform: 'uppercase', letterSpacing: '.04em' } },
                          grouped[provider].label === provider ? provider : `${provider} · ${grouped[provider].label}`),
                        grouped[provider].models.map((model) => {
                          const configured = (configuredModels || []).find((entry) => entry.kind === 'native' && entry.provider === model.provider && entry.model === model.model);
                          const checked = configured ? selectedModels.has(configured.id) : false;
                          return h('label', { key: model.model, className: cx('me-list-row', checked && 'selected') },
                            h('span', { className: 'me-row' },
                              h('input', {
                                type: 'checkbox',
                                checked,
                                onChange: async () => {
                                  if (!configured) {
                                    const next = [...(configuredModels || []), { id: `native-${Date.now()}`, kind: 'native', label: `${model.provider_label} · ${model.model_label || model.model}`, provider: model.provider, model: model.model, enabled: true }];
                                    await api('models/save', { method: 'POST', body: { models: next } });
                                    await loadModels();
                                    setSelectedModels((prev) => new Set([...prev, next[next.length - 1].id]));
                                  } else {
                                    toggle(setSelectedModels, configured.id);
                                  }
                                },
                              }),
                              h('span', null, h('b', null, model.model_label || model.model), h('span', { className: 'me-dim' }, ` · ${model.model}`))),
                            model.description ? h('span', { className: 'me-dim' }, model.description) : null);
                        }))))),
                h('div', { className: 'me-split' },
                  h(Field, { label: 'Temperature' }, h('input', { className: 'me-input', type: 'number', step: '0.1', min: 0, max: 2, value: runSettings.temperature, onChange: (e) => setRunSettings({ ...runSettings, temperature: Number(e.target.value) }) })),
                  h(Field, { label: 'Max tokens' }, h('input', { className: 'me-input', type: 'number', min: 64, step: 128, value: runSettings.maxTokens, onChange: (e) => setRunSettings({ ...runSettings, maxTokens: Number(e.target.value) }) }))),
                h('div', { className: 'me-split' },
                  h(Field, { label: L('并发', 'Concurrency') }, h('input', { className: 'me-input', type: 'number', min: 1, max: 8, value: runSettings.concurrency, onChange: (e) => setRunSettings({ ...runSettings, concurrency: Number(e.target.value) }) })),
                  h(Field, { label: L('重试', 'Retries') }, h('input', { className: 'me-input', type: 'number', min: 0, max: 5, value: runSettings.retries, onChange: (e) => setRunSettings({ ...runSettings, retries: Number(e.target.value) }) }))),
                h('div', { className: 'me-split' },
                  h(Field, { label: L('重复次数', 'Repeats'), hint: L('>1 用于稳定性分析', '>1 for stability analysis') },
                    h('input', { className: 'me-input', type: 'number', min: 1, max: 5, value: runSettings.repeats, onChange: (e) => setRunSettings({ ...runSettings, repeats: Number(e.target.value) }) })),
                  h(Field, { label: L('选项顺序', 'Option order') },
                    h('label', { className: 'me-toggle', style: { paddingTop: '9px' } },
                      h('input', { type: 'checkbox', checked: runSettings.shuffle_options, onChange: (e) => setRunSettings({ ...runSettings, shuffle_options: e.target.checked }) }),
                      L('每重复随机打乱', 'Shuffle per repeat')))),
                h('div', { className: 'me-row' },
                  h('label', { className: 'me-toggle' }, h('input', { type: 'checkbox', checked: runSettings.include_needs_review, onChange: (e) => setRunSettings({ ...runSettings, include_needs_review: e.target.checked }) }), L('包含待复核题', 'Include needs-review')),
                  h('label', { className: 'me-toggle' }, h('input', { type: 'checkbox', checked: runSettings.include_experimental, onChange: (e) => setRunSettings({ ...runSettings, include_experimental: e.target.checked }) }), L('包含实验性题', 'Include experimental'))),
                h(Field, {
                  label: L('能力分组（可选，用于正式区分度）', 'Capability groups (optional)'),
                  hint: L('必须同时有 High 与 Low 才会启用正式区分度；留空则只给探索性结果', 'Formal discrimination needs both High and Low; leaving it empty only yields exploratory results'),
                },
                h('div', { className: 'me-scroll', style: { maxHeight: '150px', gap: '6px' } },
                  (configuredModels || []).filter((model) => selectedModels.has(model.id)).length === 0
                    ? h('div', { className: 'me-hint' }, L('先勾选模型', 'Select models first'))
                    : (configuredModels || []).filter((model) => selectedModels.has(model.id)).map((model) => h('div', { key: `grp-${model.id}`, className: 'me-list-row' },
                      h('span', { className: 'me-dim' }, model.label),
                      h('select', {
                        className: 'me-select',
                        style: { width: '110px' },
                        value: groups[model.id] || '',
                        onChange: (event) => setGroups({ ...groups, [model.id]: event.target.value }),
                      },
                      h('option', { value: '' }, '—'),
                      h('option', { value: 'high' }, 'High'),
                      h('option', { value: 'low' }, 'Low')))))),
                h('div', { className: 'me-row' },
                  h(Btn, { variant: 'brand', onClick: doRun, disabled: busy === 'run' }, busy === 'run' ? L('启动中…', 'Starting…') : L('开始评测', 'Run evaluation')),
                  run && ACTIVE.has(run.status) ? h(Btn, { variant: 'danger', onClick: doCancel }, L('取消', 'Cancel')) : null,
                  run && ['cancelled', 'completed_with_errors', 'failed'].includes(run.status) ? h(Btn, { onClick: doResume }, L('恢复缺失/重试失败', 'Resume / retry failed')) : null,
                  h(Btn, { variant: 'ghost', onClick: doMeta }, L('查看 Meta', 'Open meta-eval'))))),
            h(Card, { title: L('模型与密钥', 'Models and credentials'), subtitle: L('密钥只写入 Harness 凭据存储，不进入配置、日志或报告', 'Keys go to the Harness credential store — never config, logs or reports') },
              h('div', { className: 'me-stack' },
                (configuredModels || []).length === 0 ? h(Empty, null, L('尚无已配置模型。', 'No configured models.')) :
                  (configuredModels || []).map((model) => h('div', { key: model.id, className: 'me-list-row' },
                    h('div', { className: 'me-stack', style: { gap: '2px' } },
                      h('b', null, model.label),
                      h('span', { className: 'me-dim me-mono' }, `${model.kind === 'native' ? model.provider : model.baseUrl} / ${model.model}`),
                      model.apiKeyRef ? h('span', { className: 'me-dim me-mono' }, `key: ${model.apiKeyRef}`) : null),
                    h('div', { className: 'me-row' },
                      h(Btn, { size: 'sm', variant: 'ghost', onClick: () => testModel(model.id) }, L('测试', 'Test')),
                      h(Btn, { size: 'sm', variant: 'ghost', onClick: () => saveModelConfig((configuredModels || []).filter((entry) => entry.id !== model.id)) }, L('移除', 'Remove'))))),
                h('details', { className: 'me-card', style: { padding: '10px 12px' } },
                  h('summary', { className: 'me-hint', style: { cursor: 'pointer', fontWeight: 600 } }, L('+ 添加自定义 OpenAI 兼容端点', '+ Add a custom OpenAI-compatible endpoint')),
                  h('div', { className: 'me-stack', style: { marginTop: '10px' } },
                    h('div', { className: 'me-split' },
                      h(Field, { label: L('名称', 'Label') }, h('input', { className: 'me-input', value: newModel.label, placeholder: 'My Qwen', onChange: (e) => setNewModel({ ...newModel, label: e.target.value }) })),
                      h(Field, { label: 'Model ID' }, h('input', { className: 'me-input', value: newModel.model, placeholder: 'qwen-plus', onChange: (e) => setNewModel({ ...newModel, model: e.target.value }) }))),
                    h(Field, { label: 'Base URL' }, h('input', { className: 'me-input', value: newModel.baseUrl, onChange: (e) => setNewModel({ ...newModel, baseUrl: e.target.value }) })),
                    h(Field, { label: L('密钥引用名', 'Credential reference'), hint: L('必须以 EVALFORGE_ 开头', 'Must start with EVALFORGE_') },
                      h('input', { className: 'me-input', value: newModel.apiKeyRef, onChange: (e) => setNewModel({ ...newModel, apiKeyRef: e.target.value }) })),
                    h('div', { className: 'me-row' },
                      h('input', { className: 'me-input', type: 'password', placeholder: L('粘贴 API Key（仅保存到凭据存储）', 'Paste API key (stored in the credential vault only)'), value: keyDraft, onChange: (e) => setKeyDraft(e.target.value) }),
                      h(Btn, { size: 'sm', onClick: () => saveKey(newModel.apiKeyRef), disabled: busy === 'saveKey' }, L('保存密钥', 'Save key'))),
                    h(Btn, {
                      size: 'sm',
                      variant: 'brand',
                      onClick: () => saveModelConfig([...(configuredModels || []), { ...newModel, id: `openai-${Date.now()}`, enabled: true }]),
                    }, L('添加模型', 'Add model'))))))),
          run ? h(Card, {
            title: L('运行进度', 'Run progress'),
            subtitle: `${run.id} · ${run.status} · ${run.settings.repeats}× · T=${run.settings.temperature}`,
            actions: h('div', { className: 'me-row' },
              h(Badge, { tone: ACTIVE.has(run.status) ? 'brand' : run.status === 'completed' ? 'success' : 'warn' }, run.status),
              run.progress ? h('span', { className: 'me-dim me-mono' }, `${run.progress.success} ✓ / ${run.progress.parse_failed} ? / ${run.progress.error} ✕`) : null),
          },
            h('div', { className: 'me-stack' },
              h(Progress, { value: percent, label: `${run.progress ? run.progress.done : 0} / ${totalCells}` }),
              h('div', { className: 'me-hint' }, L('失败调用不计为答错；未解析回复单独统计。', 'Failed calls are not scored as wrong; unparsed replies are counted separately.')),
              renderRunTable(run))) : null);
      }

      function renderRunTable(runData) {
        const head = h('thead', null, h('tr', null,
          h('th', null, L('题目', 'Item')),
          h('th', null, L('模型', 'Model')),
          h('th', null, L('回复', 'Response')),
          h('th', null, L('解析', 'Parsed')),
          h('th', null, 'GT'),
          h('th', null, L('结果', 'Result')),
          h('th', null, 'ms')));

        const rows = (runData.results || []).slice(-160).reverse().map((cell) => {
          const preview = (cell.response_text || (cell.error && cell.error.message) || '').slice(0, 70);
          const outcome = cell.status === 'success'
            ? h(Badge, { tone: cell.correct ? 'success' : 'danger' }, cell.correct ? '✓' : '✕')
            : h(Badge, { tone: 'warn' }, cell.status === 'error' ? (cell.error && cell.error.code) || 'error' : 'unparsed');
          return h('tr', { key: cell.cell_key, className: 'me-clickable', onClick: () => setCellDetail(cell) },
            h('td', { className: 'me-mono' }, cell.item_id),
            h('td', null, cell.model_label),
            h('td', null, h('span', { className: 'me-dim' }, preview)),
            h('td', null, cell.parsed_answer || '—'),
            h('td', null, cell.ground_truth || '—'),
            h('td', null, outcome),
            h('td', { className: 'me-num' }, cell.latency_ms || '—'));
        });

        return h('div', { className: 'me-table-wrap', style: { maxHeight: '420px' } },
          h('table', { className: 'me-table' }, head, h('tbody', null, rows)));
      }

      function renderCellModal() {
        const cell = cellDetail;
        return h(Modal, { title: `${cell.item_id} · ${cell.model_label}`, subtitle: `${cell.task_type} · repeat ${cell.repeat}`, onClose: () => setCellDetail(null) },
          h('dl', { className: 'me-kv' },
            h('dt', null, L('状态', 'Status')), h('dd', null, cell.status),
            h('dt', null, L('解析答案', 'Parsed')), h('dd', null, cell.parsed_answer || '—'),
            h('dt', null, 'GT'), h('dd', null, cell.ground_truth || '—'),
            h('dt', null, L('正确', 'Correct')), h('dd', null, cell.correct === null ? '—' : String(cell.correct)),
            h('dt', null, L('延迟', 'Latency')), h('dd', null, `${cell.latency_ms} ms`),
            h('dt', null, 'Tokens'), h('dd', null, JSON.stringify(cell.usage || {})),
            h('dt', null, L('选项映射', 'Option map')), h('dd', { className: 'me-mono' }, JSON.stringify(cell.option_map || {})),
            h('dt', null, L('错误', 'Error')), h('dd', null, cell.error ? `${cell.error.code}: ${cell.error.message}` : '—')),
          h('div', { className: 'me-mono', style: { whiteSpace: 'pre-wrap', background: 'var(--dsw-alias-bg-layer-2, #f6f7f9)', padding: '10px', borderRadius: '10px', maxHeight: '320px', overflow: 'auto' } }, cell.response_text || '(no response)'));
      }

      /* ----------------------------- meta tab ------------------------------ */

      function renderTaskTable(metaData, modelRows) {
        const tasks = metaData.tasks || [];
        if (!tasks.length) return h(Empty, null, '—');
        const head = h('thead', null, h('tr', null,
          h('th', null, L('任务', 'Task')),
          h('th', null, L('题数', 'Items')),
          modelRows.map((row) => h('th', { key: row.model_id }, row.label))));
        const rows = tasks.map((task) => {
          const cells = modelRows.map((model) => {
            const entry = (task.per_model || []).find((row) => row.model_id === model.model_id);
            return h('td', { key: model.model_id, className: 'me-num' }, entry && entry.n ? `${fmtPct(entry.accuracy)} (n=${entry.n})` : '—');
          });
          const label = TASK_LABEL[task.task_type] ? TASK_LABEL[task.task_type][lang === 'zh' ? 0 : 1] : task.task_type;
          return h('tr', { key: task.task_type },
            h('td', null, label),
            h('td', { className: 'me-num' }, task.items),
            cells);
        });
        return h('div', { className: 'me-table-wrap' },
          h('table', { className: 'me-table' }, head, h('tbody', null, rows)));
      }

      function renderModelBars(modelRows) {
        if (!modelRows.length) return h(Empty, null, '—');
        return h('div', { className: 'me-stack' }, modelRows.map((row) => h('div', { key: row.model_id, className: 'me-bar-row' },
          h('span', null, row.label),
          h('span', { className: 'me-bar' }, h('span', { style: { width: `${(row.accuracy || 0) * 100}%` } })),
          h('span', { className: 'me-mono', style: { textAlign: 'right' } }, fmtPct(row.accuracy)))));
      }

      function renderDifficultyTable(rows) {
        if (!rows.length) return h(Empty, null, '—');
        const head = h('thead', null, h('tr', null,
          h('th', null, 'Item'),
          h('th', null, L('任务', 'Task')),
          h('th', null, L('难度', 'Difficulty')),
          h('th', null, 'P(correct)'),
          h('th', null, L('模型数', 'Models')),
          h('th', null, L('质量', 'Quality'))));
        const body = rows.map((row) => h('tr', { key: row.item_id },
          h('td', { className: 'me-mono' }, row.item_id),
          h('td', null, TASK_LABEL[row.task_type] ? TASK_LABEL[row.task_type][lang === 'zh' ? 0 : 1] : row.task_type),
          h('td', null, h('div', { className: 'me-bar' }, h('span', { style: { width: `${(row.difficulty || 0) * 100}%` } }))),
          h('td', { className: 'me-num' }, fmtNum(row.p_correct)),
          h('td', { className: 'me-num' }, row.n_models),
          h('td', null, h(Badge, { tone: STATUS_TONE[row.quality_status] || 'neutral' }, row.quality_status))));
        return h('div', { className: 'me-table-wrap', style: { maxHeight: '380px' } },
          h('table', { className: 'me-table' }, head, h('tbody', null, body)));
      }

      function renderDiscriminationTable(rows) {
        const filtered = rows.filter((row) => row.d !== null).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 12);
        if (!filtered.length) return h(Empty, null, '—');
        const head = h('thead', null, h('tr', null,
          h('th', null, 'Item'), h('th', null, 'P(high)'), h('th', null, 'P(low)'), h('th', null, 'D')));
        const body = filtered.map((row) => h('tr', { key: row.item_id },
          h('td', { className: 'me-mono' }, row.item_id),
          h('td', { className: 'me-num' }, fmtNum(row.p_high)),
          h('td', { className: 'me-num' }, fmtNum(row.p_low)),
          h('td', { className: 'me-num' }, fmtNum(row.d, 3))));
        return h('div', { className: 'me-table-wrap', style: { maxHeight: '200px' } },
          h('table', { className: 'me-table' }, head, h('tbody', null, body)));
      }

      function renderContentious(rows) {
        if (!rows.length) return h(Empty, null, L('当前运行没有高争议题目（或样本不足）。', 'No contentious items at this sample size.'));
        return h('div', { className: 'me-scroll' }, rows.map((row) => h('div', { key: row.item_id, className: 'me-list-row' },
          h('div', { className: 'me-stack', style: { gap: '2px' } },
            h('span', { className: 'me-mono' }, `${row.item_id} · ${row.nct_id}`),
            h('span', { className: 'me-dim' }, row.question)),
          h('div', { className: 'me-row' },
            h(Badge, { tone: 'warn' }, `P=${fmtNum(row.p_correct)}`),
            h(Btn, {
              size: 'sm',
              variant: 'ghost',
              onClick: () => {
                const item = ((benchmark && benchmark.items) || []).find((entry) => entry.id === row.item_id);
                if (item) {
                  setActiveItem(item);
                  setTab('builder');
                }
              },
            }, L('查看', 'View'))))));
      }

      function renderFailureTable(rows) {
        if (!rows.length) return null;
        const head = h('thead', null, h('tr', null,
          h('th', null, L('模型', 'Model')),
          h('th', null, 'Code'),
          h('th', null, L('次数', 'Count')),
          h('th', null, L('示例', 'Sample'))));
        const body = rows.map((row, index) => h('tr', { key: index },
          h('td', null, row.label),
          h('td', { className: 'me-mono' }, row.code),
          h('td', { className: 'me-num' }, row.count),
          h('td', { className: 'me-dim' }, String(row.sample || '').slice(0, 90))));
        return h('div', { className: 'me-table-wrap' }, h('table', { className: 'me-table' }, head, h('tbody', null, body)));
      }

      function renderMeta() {
        if (!meta) {
          return h(Card, { title: 'Meta-Eval', subtitle: L('先完成一次评测', 'Run an evaluation first') },
            h('div', { className: 'me-stack' },
              h(Empty, null, L('还没有可分析的运行结果。', 'No run results to analyse yet.')),
              h('div', { className: 'me-row' },
                h('select', {
                  className: 'me-select',
                  style: { width: '320px' },
                  value: run ? run.id : '',
                  onChange: async (event) => {
                    const data = await api(`run?run_id=${encodeURIComponent(event.target.value)}`);
                    setRun(data.run);
                    const metaData = await api(`meta?run_id=${encodeURIComponent(event.target.value)}`);
                    setMeta(metaData.meta);
                  },
                }, (runs || []).map((entry) => h('option', { key: entry.id, value: entry.id }, `${entry.id} · ${entry.benchmark_name} · ${entry.status}`))),
                h(Btn, { onClick: doMeta }, L('加载分析', 'Load analysis')))));
        }

        const modelRows = meta.models || [];
        const difficultyRows = (meta.difficulty || []).filter((row) => {
          if (metaFilter.task_type && row.task_type !== metaFilter.task_type) return false;
          if (metaFilter.quality !== 'all' && row.quality_status !== metaFilter.quality) return false;
          return true;
        }).sort((a, b) => {
          if (difficultySort === 'difficult') return (b.difficulty ?? -1) - (a.difficulty ?? -1);
          if (difficultySort === 'easy') return (a.difficulty ?? 2) - (b.difficulty ?? 2);
          return String(a.item_id).localeCompare(String(b.item_id));
        });

        const stability = meta.stability || [];
        const stabilityText = stability.length
          ? `${L('稳定性样本', 'Stability items')}: ${stability.length} · ${L('平均一致率', 'mean consistency')} ${fmtNum(stability.reduce((sum, row) => sum + (row.consistency || 0), 0) / stability.length, 3)}`
          : L('本运行未做重复采样，无稳定性指标。', 'No repeated sampling in this run.');

        return h('div', { className: 'me-grid' },
          h('div', { className: 'me-row' },
            h('span', { className: 'me-dim' }, `${meta.run_id} · ${meta.sample.benchmark_name}`),
            h(Badge, { tone: 'neutral' }, `${meta.sample.items} ${L('题', 'items')} × ${meta.sample.models} ${L('模型', 'models')}`),
            h(Badge, { tone: meta.discrimination_mode === 'declared' ? 'success' : 'warn' }, `${L('区分度', 'Discrimination')}: ${meta.discrimination_mode}`),
            h(Badge, { tone: 'neutral' }, `${L('失败', 'Failures')}: ${meta.sample.failures}`),
            meta.sample.reasoning_derived ? h(Badge, { tone: 'warn' }, `${L('推理截断恢复', 'reasoning-derived')}: ${meta.sample.reasoning_derived}`) : null),
          modelRows.length
            ? h('div', { className: 'me-grid me-grid-3' }, modelRows.map((row) => h(Stat, {
              key: row.model_id,
              label: row.label,
              value: fmtPct(row.accuracy),
              hint: `${L('题数', 'n')}=${row.scored} · F1 ${fmtNum(row.macro_f1, 3)} · ${row.failures} ${L('失败', 'failed')}`,
            })))
            : null,
          h('div', { className: 'me-grid me-grid-2' },
            h(Card, {
              title: L('模型对比', 'Model comparison'),
              subtitle: L('准确率 = 正确 / 可评分；失败不计为错', 'Accuracy = correct / scored; failures excluded'),
            }, renderModelBars(modelRows)),
            h(Card, { title: L('任务维度', 'By task') }, renderTaskTable(meta, modelRows))),
          h(Card, {
            title: L('题目难度', 'Item difficulty'),
            subtitle: L('经验难度 = 1 − 正确率；按每模型均值再平均', 'Difficulty = 1 − p(correct), averaged per model first'),
            actions: h('div', { className: 'me-row' },
              h('select', {
                className: 'me-select',
                style: { width: '150px' },
                value: metaFilter.task_type,
                onChange: (event) => setMetaFilter({ ...metaFilter, task_type: event.target.value }),
              },
              h('option', { value: '' }, L('全部任务', 'All tasks')),
              Object.keys(TASK_LABEL).map((task) => h('option', { key: task, value: task }, TASK_LABEL[task][lang === 'zh' ? 0 : 1]))),
              h('select', {
                className: 'me-select',
                style: { width: '130px' },
                value: difficultySort,
                onChange: (event) => setDifficultySort(event.target.value),
              },
              h('option', { value: 'difficult' }, L('最难优先', 'Hardest first')),
              h('option', { value: 'easy' }, L('最易优先', 'Easiest first')),
              h('option', { value: 'id' }, 'ID'))),
          }, renderDifficultyTable(difficultyRows)),
          h('div', { className: 'me-grid me-grid-2' },
            h(Card, {
              title: L('高争议题目', 'Contentious items'),
              subtitle: L('0 < P < 1 且接近 0.5', '0 < P < 1, closest to 0.5'),
            }, renderContentious(meta.contentious || [])),
            h(Card, { title: L('区分度与稳定性', 'Discrimination & stability') },
              h('div', { className: 'me-stack' },
                meta.discrimination_mode === 'declared'
                  ? h('div', { className: 'me-hint' }, L('使用运行前声明的能力分组计算正式区分度。', 'Formal discrimination from capability groups declared before the run.'))
                  : h('div', { className: 'me-warn' }, L('当前为探索性区分度：分组来自本次整体准确率，不能作为独立的模型能力结论。', "Exploratory only: groups come from this run's overall accuracy, not an independent capability measure.")),
                renderDiscriminationTable(meta.discrimination || []),
                h('div', { className: 'me-hint' }, stabilityText)))),
          renderFailureTable(meta.failures || []),
          h('div', { className: 'me-hint' }, (meta.notes || []).join(' · ')));
      }

      /* ---------------------------- reports tab --------------------------- */

      function renderReports() {
        const files = [
          ['jsonl', 'benchmark.jsonl', L('Benchmark 题目全集（含 GT 与证据链）', 'Benchmark items (GT + evidence)')],
          ['csv', 'eval_results.csv', L('逐题逐模型的评分明细', 'Per-item, per-model scoring rows')],
          ['json', 'eval_results.json', L('运行配置 + 结果 + Meta 分析', 'Run config + results + meta analysis')],
          ['markdown', 'meta_eval_report.md', L('可读评测报告（含局限说明）', 'Human-readable report with limitations')],
        ];
        return h('div', { className: 'me-grid me-grid-2' },
          h(Card, { title: L('导出当前运行', 'Export the current run'), subtitle: run ? run.id : L('暂无运行', 'No run') },
            h('div', { className: 'me-stack' },
              h('div', { className: 'me-row' },
                h('select', { className: 'me-select', style: { maxWidth: '420px' }, value: run ? run.id : '', onChange: async (e) => {
                  const data = await api(`run?run_id=${encodeURIComponent(e.target.value)}`);
                  setRun(data.run);
                } },
                  (runs || []).map((entry) => h('option', { key: entry.id, value: entry.id }, `${entry.id} · ${entry.benchmark_name} · ${entry.status}`)))),
              files.map(([format, name, description]) => h('div', { key: format, className: 'me-list-row' },
                h('div', { className: 'me-stack', style: { gap: '2px' } }, h('b', null, name), h('span', { className: 'me-dim' }, description)),
                h(Btn, { size: 'sm', onClick: () => doExport(format), disabled: !run || busy === `export-${format}` }, L('下载', 'Download')))),
              h('div', { className: 'me-hint' }, L('报告包含数据来源、生成方法、有效题数、模型信息、评分结果、难度/区分度与局限性；不包含任何 API Key。', 'Reports include provenance, generation method, valid item counts, models, scores, difficulty/discrimination and limitations. No API keys.')))),
          h('div', { className: 'me-stack' },
            h(Card, { title: L('历史运行', 'Run history') },
              (runs || []).length ? h('div', { className: 'me-scroll' }, runs.map((entry) => h('div', { key: entry.id, className: 'me-list-row' },
                h('div', { className: 'me-stack', style: { gap: '2px' } },
                  h('b', null, entry.benchmark_name || entry.id),
                  h('span', { className: 'me-dim me-mono' }, `${entry.id} · ${entry.status} · ${entry.cells} cells`),
                  h('span', { className: 'me-dim' }, fmtDate(entry.created_at))),
                h('div', { className: 'me-row' },
                  h(Btn, { size: 'sm', variant: 'ghost', onClick: async () => {
                    const data = await api(`run?run_id=${encodeURIComponent(entry.id)}`);
                    setRun(data.run);
                    const metaData = await api(`meta?run_id=${encodeURIComponent(entry.id)}`);
                    setMeta(metaData.meta);
                    setTab('meta');
                  } }, L('分析', 'Analyse')))))) : h(Empty, null, L('暂无历史', 'No history'))),
            h(Card, { title: L('数据目录', 'Data directory') },
              h('dl', { className: 'me-kv' },
                h('dt', null, L('目录', 'Directory')), h('dd', { className: 'me-mono' }, boot.data ? boot.data.data_dir : '—'),
                h('dt', null, L('语料文件', 'Corpus')), h('dd', { className: 'me-mono' }, boot.data ? boot.data.corpus_file : '—'),
                h('dt', null, L('配置', 'Config')), h('dd', { className: 'me-mono' }, boot.data ? boot.data.config_file : '—')),
              h('div', { className: 'me-hint', style: { marginTop: '8px' } }, L('所有数据本地持久化，重新打开插件后仍可继续。', 'Everything persists locally across sessions.')))));
      }
    }

    const name = 'dsh-plugin-evalforge';
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      const disposeLocale = ctx.locale.register(NS, { zh, en });
      ctx.effect(() => disposeLocale, 'evalforge: locale dictionary');
      const disposeStyle = installStyle();
      ctx.effect(() => disposeStyle, 'evalforge: stylesheet');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'evalforge',
        locale: NS,
        inject: () => ({ locale: ctx.locale, t }),
      }, EvalForgePage));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'evalforge',
        order: 2,
        label: () => t('nav'),
        locale: NS,
      }, (owner = {}) => h(EvalForgeIcon, { size: owner.size || 18, active: owner.active === true })));
    }

    function EvalForgeIcon({ size = 18, active = false }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 2, y: 2, width: 20, height: 20, rx: 6, fill: active ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.6, opacity: active ? 0.14 : 1 }),
        h('path', { d: 'M7 8h10M7 12h7M7 16h8', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('circle', { cx: 17, cy: 16, r: 3, fill: 'currentColor' }));
    }

    return { name, inject, apply };
  },
});
