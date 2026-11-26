// Accessible, viewport-pinned custom modal & confirmation dialogs

export function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Pins a fixed modal backdrop to `window.visualViewport` so mobile virtual keyboards
 * never push or clip the dialog.
 */
export function bindViewportPin(backdropEl) {
    let timers = [];
    const clearTimers = () => {
        for (const t of timers) clearTimeout(t);
        timers = [];
    };

    const sync = () => {
        if (!backdropEl.isConnected) return;
        const vv = window.visualViewport;
        if (vv) {
            backdropEl.style.top = `${Math.round(vv.offsetTop)}px`;
            backdropEl.style.left = `${Math.round(vv.offsetLeft)}px`;
            backdropEl.style.width = `${Math.round(vv.width)}px`;
            backdropEl.style.height = `${Math.round(vv.height)}px`;
            backdropEl.style.right = 'auto';
            backdropEl.style.bottom = 'auto';
        }
    };

    const settleSync = () => {
        clearTimers();
        sync();
        requestAnimationFrame(sync);
        for (const delay of [60, 180, 360]) {
            timers.push(setTimeout(sync, delay));
        }
    };

    sync();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', sync);
    vv?.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    backdropEl.addEventListener('focusin', settleSync);
    backdropEl.addEventListener('focusout', settleSync);

    return () => {
        clearTimers();
        vv?.removeEventListener('resize', sync);
        vv?.removeEventListener('scroll', sync);
        window.removeEventListener('resize', sync);
        backdropEl.removeEventListener('focusin', settleSync);
        backdropEl.removeEventListener('focusout', settleSync);
    };
}

/**
 * Prevents pointer/touch events inside our custom dialogs from triggering SillyTavern's drawer auto-closers.
 */
export function shieldDialogEvents(el) {
    for (const evt of ['touchstart', 'mousedown', 'mouseup', 'touchend']) {
        el.addEventListener(evt, e => e.stopPropagation());
    }
}

/**
 * Opens a compact stacked confirmation / choice dialog (e.g. unsaved changes guard, delete confirm).
 */
export function openSubDialog({ title, bodyHtml, checkboxLabel = '', checkboxDefault = false, buttons = [] }) {
    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'lk-backdrop lk-backdrop-sub ui-widget';

        const checkHtml = checkboxLabel ? `
            <label class="checkbox_label lk-check-row lk-sub-check">
                <input type="checkbox" class="lk-sub-checkbox" ${checkboxDefault ? 'checked' : ''} />
                <span>${esc(checkboxLabel)}</span>
            </label>
        ` : '';

        const btnsHtml = buttons.map((b) => {
            const cls = b.variant === 'primary'
                ? 'menu_button lk-btn lk-btn-primary'
                : b.variant === 'danger'
                    ? 'menu_button lk-btn lk-btn-danger'
                    : b.variant === 'ghost'
                        ? 'menu_button lk-btn lk-btn-ghost'
                        : 'menu_button lk-btn lk-btn-secondary';
            const iconHtml = b.icon ? `<i class="${esc(b.icon)}"></i>` : '';
            return `<button type="button" class="${cls}" data-choice="${esc(b.key)}">${iconHtml}<span>${esc(b.label)}</span></button>`;
        }).join('');

        backdrop.innerHTML = `
            <div class="lk-sub-card" role="alertdialog" aria-modal="true">
                <div class="lk-sub-header">
                    <div class="lk-sub-title">${esc(title)}</div>
                    <button type="button" class="lk-icon-close" data-choice="__close__" title="关闭"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="lk-sub-body">${bodyHtml}</div>
                ${checkHtml}
                <div class="lk-sub-footer">${btnsHtml}</div>
            </div>
        `;

        shieldDialogEvents(backdrop);
        let unbindVp = null;
        let settled = false;

        const finish = (choice) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            const checked = Boolean(backdrop.querySelector('.lk-sub-checkbox')?.checked);
            unbindVp?.();
            backdrop.classList.add('is-closing');
            setTimeout(() => backdrop.remove(), 120);
            resolve({ choice, checked });
        };

        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                finish(null);
            }
        };

        backdrop.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target === backdrop) {
                finish(null);
                return;
            }
            const btn = e.target.closest('[data-choice]');
            if (!btn) return;
            const ch = btn.dataset.choice;
            finish(ch === '__close__' ? null : ch);
        });

        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(backdrop);
        unbindVp = bindViewportPin(backdrop);
    });
}

/**
 * Prompts user when they have unsaved edits in the composer and try to close or switch context.
 * @returns {Promise<'save' | 'discard' | 'cancel'>}
 */
export async function promptUnsavedChanges(contextDesc = '当前编辑的绑定配置尚未保存') {
    const { choice } = await openSubDialog({
        title: '有未保存的绑定修改',
        bodyHtml: `<p class="lk-sub-text">${esc(contextDesc)}。如果直接退出，刚才选好的内容不会生效。</p>`,
        buttons: [
            { key: 'cancel', label: '返回编辑', variant: 'ghost' },
            { key: 'discard', label: '放弃修改', variant: 'secondary' },
            { key: 'save', label: '保存并继续', variant: 'primary', icon: 'fa-solid fa-check' },
        ],
    });
    if (choice === 'save') return 'save';
    if (choice === 'discard') return 'discard';
    return 'cancel';
}

/**
 * Prompts user when an unbound preset is detected as a likely new version of a bound preset.
 * @returns {Promise<{ action: 'bind' | 'skip' | 'ignore', syncChars: boolean }>}
 */
export async function promptPresetUpdateDetected({
    newPresetName,
    matchedPreset,
    groupName = '',
    lorebooks,
    availableWorldNames = [],
    affectedCharNames = [],
    defaultSyncChars = false,
}) {
    const worldSet = new Set(availableWorldNames);
    const pillsHtml = lorebooks.map((b) => {
        const exists = worldSet.size === 0 || worldSet.has(b);
        return `<span class="lk-chip ${exists ? '' : 'is-missing'}"><i class="fa-solid fa-book-atlas"></i><span>${esc(b)}${exists ? '' : ' (未找到)'}</span></span>`;
    }).join('');

    const groupDesc = groupName ? `（所属绑定：<b>${esc(groupName)}</b>）` : '';
    const bodyHtml = `
        <p class="lk-sub-text">
            检测到当前预设 <b>「${esc(newPresetName)}」</b> 与已绑定的 <b>「${esc(matchedPreset)}」</b>${groupDesc} 名称近似，疑似更新版本。是否将其加入同一世界书绑定关系？
        </p>
        <div class="lk-sub-preview-label">将自动启用以下 ${lorebooks.length} 本世界书：</div>
        <div class="lk-chip-wrap">${pillsHtml}</div>
    `;

    const checkboxLabel = affectedCharNames.length > 0
        ? `同时将关联角色（${affectedCharNames.slice(0, 3).join('、')}${affectedCharNames.length > 3 ? ` 等 ${affectedCharNames.length} 个` : ''}）的绑定预设更新为新版`
        : '';

    const { choice, checked } = await openSubDialog({
        title: '识别到疑似新版预设',
        bodyHtml,
        checkboxLabel,
        checkboxDefault: defaultSyncChars,
        buttons: [
            { key: 'ignore', label: '不再提醒此预设', variant: 'ghost' },
            { key: 'skip', label: '本次不绑定', variant: 'secondary' },
            { key: 'bind', label: '立即绑定并启用', variant: 'primary', icon: 'fa-solid fa-link' },
        ],
    });

    if (choice === 'bind') return { action: 'bind', syncChars: checked };
    if (choice === 'ignore') return { action: 'ignore', syncChars: false };
    return { action: 'skip', syncChars: false };
}
