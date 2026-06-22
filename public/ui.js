// Shared in-app dialogs: drop-in replacements for native alert/confirm/prompt,
// plus a toast and a generic multi-button dialog. All return Promises.
(function () {
    if (window.uiConfirm) return;

    const style = document.createElement('style');
    style.textContent = `
        .ui-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 3000;
            display: flex; align-items: center; justify-content: center; padding: 20px; }
        .ui-card { background: #1e1e1e; border: 1px solid #444; border-radius: 16px; padding: 22px;
            max-width: 360px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.6); color: #e3e3e3;
            font-family: system-ui, -apple-system, sans-serif; text-align: left; }
        .ui-title { font-size: 1.2rem; font-weight: 800; color: #fff; margin-bottom: 12px; word-break: break-word; }
        .ui-msg, .ui-body { font-size: 0.95rem; line-height: 1.6; margin-bottom: 16px; word-break: break-word; }
        .ui-body .k { color: #888; }
        .ui-input { width: 100%; box-sizing: border-box; background: #2d2d2d; border: 1px solid #444; color: #fff;
            padding: 10px 12px; border-radius: 8px; font-size: 0.95rem; margin-bottom: 16px; }
        .ui-input:focus { outline: 2px solid #008CFF; border-color: transparent; }
        .ui-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
        .ui-btn { padding: 9px 18px; border: none; border-radius: 50px; font-weight: 700; font-size: 0.85rem; cursor: pointer; }
        .ui-btn.primary { background: #008CFF; color: #fff; }
        .ui-btn.ghost { background: #333; color: #fff; }
        .ui-btn.danger { background: #ff6b6b; color: #1a0000; }
        .ui-toast { position: fixed; bottom: 24px; left: 50%; transform: translate(-50%, 20px); opacity: 0;
            background: #2a2a2a; color: #fff; border: 1px solid #444; padding: 10px 18px; border-radius: 50px;
            font-family: system-ui, -apple-system, sans-serif; font-size: 0.88rem; z-index: 3100;
            transition: all 0.25s; box-shadow: 0 6px 20px rgba(0,0,0,0.5); }
        .ui-toast.show { opacity: 1; transform: translate(-50%, 0); }
    `;
    document.head.appendChild(style);

    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    function build(inner) {
        const overlay = document.createElement('div');
        overlay.className = 'ui-overlay';
        overlay.innerHTML = `<div class="ui-card">${inner}</div>`;
        document.body.appendChild(overlay);
        return overlay;
    }

    window.uiAlert = (message, okText) => new Promise((resolve) => {
        const o = build(`<div class="ui-msg">${esc(message)}</div><div class="ui-actions"><button class="ui-btn primary">${esc(okText || 'OK')}</button></div>`);
        const done = () => { o.remove(); resolve(); };
        o.querySelector('.ui-btn').onclick = done;
        o.addEventListener('click', (e) => { if (e.target === o) done(); });
    });

    window.uiConfirm = (message, opts) => new Promise((resolve) => {
        opts = opts || {};
        const o = build(`<div class="ui-msg">${esc(message)}</div><div class="ui-actions">
            <button class="ui-btn ghost" data-no>${esc(opts.cancelText || 'Cancel')}</button>
            <button class="ui-btn ${opts.danger ? 'danger' : 'primary'}" data-yes>${esc(opts.okText || 'OK')}</button></div>`);
        const close = (v) => { o.remove(); resolve(v); };
        o.querySelector('[data-yes]').onclick = () => close(true);
        o.querySelector('[data-no]').onclick = () => close(false);
        o.addEventListener('click', (e) => { if (e.target === o) close(false); });
    });

    window.uiPrompt = (message, opts) => new Promise((resolve) => {
        opts = opts || {};
        const o = build(`<div class="ui-msg">${esc(message)}</div>
            <input class="ui-input" value="${esc(opts.defaultValue || '')}" placeholder="${esc(opts.placeholder || '')}">
            <div class="ui-actions"><button class="ui-btn ghost" data-no>Cancel</button>
            <button class="ui-btn primary" data-yes>${esc(opts.okText || 'OK')}</button></div>`);
        const input = o.querySelector('.ui-input');
        input.focus(); input.select();
        const close = (v) => { o.remove(); resolve(v); };
        o.querySelector('[data-yes]').onclick = () => close(input.value);
        o.querySelector('[data-no]').onclick = () => close(null);
        input.addEventListener('keyup', (e) => { if (e.key === 'Enter') close(input.value); if (e.key === 'Escape') close(null); });
        o.addEventListener('click', (e) => { if (e.target === o) close(null); });
    });

    // Generic dialog: buttons = [{ text, class, value }]. Resolves with the chosen value.
    // bodyHtml is trusted: callers must escape any user data they inject.
    window.uiDialog = ({ title, bodyHtml, buttons }) => new Promise((resolve) => {
        const btns = (buttons || []).map((b, i) => `<button class="ui-btn ${b.class || 'ghost'}" data-i="${i}">${esc(b.text)}</button>`).join('');
        const o = build(`${title ? `<div class="ui-title">${esc(title)}</div>` : ''}<div class="ui-body">${bodyHtml || ''}</div><div class="ui-actions">${btns}</div>`);
        const close = (v) => { o.remove(); resolve(v); };
        o.querySelectorAll('[data-i]').forEach((el) => { el.onclick = () => close(buttons[+el.dataset.i].value); });
        o.addEventListener('click', (e) => { if (e.target === o) close(undefined); });
    });

    window.uiToast = (message) => {
        const t = document.createElement('div');
        t.className = 'ui-toast'; t.innerText = message;
        document.body.appendChild(t);
        requestAnimationFrame(() => t.classList.add('show'));
        setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 1800);
    };
})();
