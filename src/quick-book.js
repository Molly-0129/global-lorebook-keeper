// Quick Book Viewer (快速翻书): input-bar button + per-chat lorebook & entry switcher

import {
    currentChat,
    readChatBinding,
    resetChatBookEntryOverrides,
    saveChatEntryOverride,
    unbindChatLorebook,
} from './chat.js';
import { syncActivePresetImmediately } from './core.js';
import { bindViewportPin, esc, shieldDialogEvents } from './dialog.js';
import {
    getCurrentCharacter,
    getCurrentPresetName,
    getSelectedWorldInfo,
    getStContext,
    getWorldInfoSettings,
    getWorldNames,
    loadWorldInfoData,
} from './st-env.js';
import { getLorebooksForPreset, loadSettings, uniqueStrings } from './storage.js';

const QUICK_BTN_ID = 'lk-quick-book-btn';
const QUICK_MODAL_ID = 'lk-qb-backdrop';

let activeQuickModal = null;
let openMainPanelHandler = null;

export function setQuickBookMainPanelHandler(fn) {
    openMainPanelHandler = fn;
}

function getAvatarStem(avatar) {
    return String(avatar || '').replace(/\.[^/.]+$/, '');
}

/**
 * Collects all lorebooks active for the current chat along with their source tags.
 * Mirrors SillyTavern's Global, Chat, Character (primary + extra), and Persona lore sources.
 */
export function collectActiveChatBookSources() {
    const ctx = getStContext();
    const settings = loadSettings();
    const chat = currentChat();
    const chatBinding = chat ? readChatBinding(chat) : {};
    const currentPreset = getCurrentPresetName();

    const chatBoundSet = new Set(uniqueStrings(chatBinding.lorebooks));
    const presetBoundSet = new Set(getLorebooksForPreset(settings, currentPreset));
    const selectedGlobal = uniqueStrings(getSelectedWorldInfo());
    const availableWorldSet = new Set(getWorldNames());

    const bookMap = new Map();
    const addBook = (name, sourceTag, { isChatBound = false } = {}) => {
        const clean = String(name || '').trim();
        if (!clean) return;
        let item = bookMap.get(clean);
        if (!item) {
            item = {
                name: clean,
                sources: [],
                isChatBound: false,
                exists: availableWorldSet.size === 0 || availableWorldSet.has(clean),
            };
            bookMap.set(clean, item);
        }
        if (sourceTag && !item.sources.includes(sourceTag)) {
            item.sources.push(sourceTag);
        }
        if (isChatBound) item.isChatBound = true;
    };

    // 1. Plugin chat-bound lorebooks (highest visibility & supports fast unbind)
    for (const book of chatBoundSet) {
        addBook(book, '当前聊天绑定', { isChatBound: true });
    }

    // 2. SillyTavern native chat-bound lorebook (`chatMetadata.world_info`)
    const nativeChatWorld = ctx?.chatMetadata?.world_info;
    if (typeof nativeChatWorld === 'string' && nativeChatWorld.trim()) {
        addBook(nativeChatWorld, '酒馆聊天书');
    }

    // 3. Character primary & extra lorebooks
    const character = getCurrentCharacter();
    if (character) {
        const primaryCharWorld = character?.data?.extensions?.world;
        if (typeof primaryCharWorld === 'string' && primaryCharWorld.trim()) {
            addBook(primaryCharWorld, '角色主书');
        }
        const wi = getWorldInfoSettings();
        const stem = getAvatarStem(character.avatar);
        const extraCharEntry = Array.isArray(wi.charLore)
            ? wi.charLore.find(e => e?.name === stem || e?.name === character.avatar)
            : null;
        if (Array.isArray(extraCharEntry?.extraBooks)) {
            for (const b of extraCharEntry.extraBooks) {
                addBook(b, '角色附加');
            }
        }
    }

    // 4. Persona lorebook
    const personaWorld = ctx?.powerUserSettings?.persona_description_lorebook;
    if (typeof personaWorld === 'string' && personaWorld.trim()) {
        addBook(personaWorld, '人设世界书');
    }

    // 5. Globally selected lorebooks (distinguishing preset-bound vs manual global)
    for (const book of selectedGlobal) {
        if (presetBoundSet.has(book)) {
            addBook(book, '预设绑定');
        } else if (!chatBoundSet.has(book)) {
            addBook(book, '全局');
        }
    }

    return Array.from(bookMap.values());
}

/**
 * Loads normalized entries for all active lorebooks in the current chat.
 */
async function loadActiveBooksWithEntries() {
    const sources = collectActiveChatBookSources();
    const chat = currentChat();
    const overrides = chat ? (readChatBinding(chat).entryOverrides || {}) : {};

    const loaded = await Promise.all(sources.map(async (book) => {
        let rawData = null;
        try {
            rawData = book.exists ? await loadWorldInfoData(book.name) : null;
        } catch (err) {
            console.warn('[LorebookKeeper] Failed to load world info:', book.name, err);
        }

        const rawEntries = rawData?.entries && typeof rawData.entries === 'object'
            ? Object.values(rawData.entries)
            : [];

        const bookOverrides = overrides[book.name] || {};
        const entries = rawEntries
            .filter(e => e && e.uid !== undefined && e.uid !== null)
            .map((e) => {
                const uid = String(e.uid);
                const keys = Array.isArray(e.key) ? e.key.filter(Boolean) : [];
                const comment = String(e.comment || '').trim();
                const title = comment || (keys.length ? keys.join(', ') : `未命名条目 #${uid}`);
                const defaultDisabled = Boolean(e.disable);
                const hasOverride = Object.hasOwn(bookOverrides, uid);
                const effectiveDisabled = hasOverride ? Boolean(bookOverrides[uid]) : defaultDisabled;
                const triggerType = e.constant ? 'constant' : (e.vectorized ? 'vector' : 'keyword');
                return {
                    uid,
                    title,
                    keys,
                    comment,
                    triggerType,
                    order: Number(e.order) || 0,
                    displayIndex: Number.isFinite(Number(e.displayIndex)) ? Number(e.displayIndex) : Number.MAX_SAFE_INTEGER,
                    defaultDisabled,
                    effectiveDisabled,
                    hasOverride,
                };
            })
            .sort((a, b) => {
                if (a.displayIndex !== b.displayIndex) return a.displayIndex - b.displayIndex;
                if (b.order !== a.order) return b.order - a.order;
                return Number(a.uid) - Number(b.uid);
            });

        return {
            ...book,
            entries,
            overrideCount: entries.filter(e => e.hasOverride).length,
            enabledCount: entries.filter(e => !e.effectiveDisabled).length,
        };
    }));

    return loaded;
}

/**
 * Updates the subtle override indicator dot and tooltip on the input-bar button.
 */
export function refreshQuickBookIndicator() {
    const btn = document.getElementById(QUICK_BTN_ID);
    if (!btn) return;
    const chat = currentChat();
    const overrides = chat ? (readChatBinding(chat).entryOverrides || {}) : {};
    let overrideTotal = 0;
    for (const bookMap of Object.values(overrides)) {
        overrideTotal += Object.keys(bookMap || {}).length;
    }
    btn.classList.toggle('has-overrides', overrideTotal > 0);
    btn.title = overrideTotal > 0
        ? `快速翻书（本聊天已独立覆写 ${overrideTotal} 个条目）`
        : '快速翻书：查看当前聊天激活的世界书与条目';
}

/**
 * Mounts or removes the Quick Book button on the top-left row of `#send_form`,
 * right beside any existing third-party top-bar button (e.g. the star icon).
 */
export function syncQuickBookButton() {
    const enabled = loadSettings().options.quickBookEnabled !== false;
    const existing = document.getElementById(QUICK_BTN_ID);

    if (!enabled) {
        existing?.remove();
        activeQuickModal?.close?.();
        return;
    }

    const sendForm = document.getElementById('send_form');
    const nonQr = document.getElementById('nonQRFormItems');
    if (!sendForm || !nonQr) return;

    let btn = existing;
    if (!btn) {
        btn = document.createElement('button');
        btn.id = QUICK_BTN_ID;
        btn.type = 'button';
        btn.className = 'lk-qb-trigger interactable';
        btn.setAttribute('aria-label', '快速翻书');
        btn.innerHTML = `<i class="fa-solid fa-book-open"></i><span class="lk-qb-btn-dot" aria-hidden="true"></span>`;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (activeQuickModal) {
                activeQuickModal.close();
            } else {
                openQuickBookPanel();
            }
        });
    }

    // Place immediately after any existing compact top-left sibling button (e.g., third-party star button)
    // so they sit neatly side-by-side on the same flex row above `#nonQRFormItems`.
    const ignoreIds = new Set(['file_form', 'nonQRFormItems', 'qr--bar', QUICK_BTN_ID]);
    const topLeftSiblings = Array.from(sendForm.children).filter((el) => {
        if (ignoreIds.has(el.id)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none') return false;
        const orderNum = Number(style.order) || 0;
        return orderNum <= 0;
    });

    if (topLeftSiblings.length > 0) {
        const anchor = topLeftSiblings[topLeftSiblings.length - 1];
        if (anchor.nextElementSibling !== btn) {
            anchor.insertAdjacentElement('afterend', btn);
        }
    } else if (btn.parentElement !== sendForm || btn.nextElementSibling !== nonQr) {
        sendForm.insertBefore(btn, nonQr);
    }

    refreshQuickBookIndicator();
}

/**
 * Opens the Quick Book Viewer floating panel.
 */
export async function openQuickBookPanel() {
    if (activeQuickModal) {
        activeQuickModal.close();
        return;
    }

    const state = {
        books: [],
        loading: true,
        search: '',
        filter: 'all', // 'all' | 'enabled' | 'overridden'
        expandedBooks: new Set(),
        initializedExpand: false,
    };

    const backdrop = document.createElement('div');
    backdrop.id = QUICK_MODAL_ID;
    backdrop.className = 'lk-backdrop lk-qb-backdrop ui-widget';
    backdrop.innerHTML = `
        <div class="lk-modal lk-qb-modal" role="dialog" aria-modal="true" aria-labelledby="lk-qb-title">
            <div class="lk-header lk-qb-header">
                <div class="lk-header-title-wrap">
                    <span class="lk-logo-badge"><i class="fa-solid fa-book-open"></i></span>
                    <div>
                        <h2 id="lk-qb-title" class="lk-title">快速翻书</h2>
                        <div class="lk-subtitle" id="lk-qb-subtitle">正在读取当前聊天激活的世界书...</div>
                    </div>
                </div>
                <div class="lk-qb-header-actions">
                    <button type="button" class="menu_button lk-btn lk-btn-xs lk-btn-ghost" data-action="open-main-binder" title="打开完整绑定管理面板">
                        <i class="fa-solid fa-sliders"></i><span>绑定器</span>
                    </button>
                    <button type="button" class="lk-icon-close lk-qb-close" title="关闭 (Esc)">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>

            <div class="lk-qb-toolbar">
                <div class="lk-search-box">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="search" id="lk-qb-search" class="text_pole lk-search-input" placeholder="搜索世界书、条目名称或关键词..." />
                </div>
                <div class="lk-qb-filters" id="lk-qb-filters"></div>
            </div>

            <div class="lk-body lk-qb-body" id="lk-qb-body"></div>
        </div>
    `;

    shieldDialogEvents(backdrop);

    let unbindVp = null;
    let closed = false;

    const close = () => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKeyDown);
        unbindVp?.();
        if (activeQuickModal?.backdrop === backdrop) activeQuickModal = null;
        backdrop.classList.add('is-closing');
        setTimeout(() => backdrop.remove(), 130);
    };

    const onKeyDown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    };

    const renderFilters = () => {
        const el = backdrop.querySelector('#lk-qb-filters');
        if (!el) return;
        const totalOverrides = state.books.reduce((sum, b) => sum + b.overrideCount, 0);
        const pills = [
            { key: 'all', label: '全部条目' },
            { key: 'enabled', label: '仅启用中' },
            { key: 'overridden', label: `本聊天已改${totalOverrides ? ` (${totalOverrides})` : ''}` },
        ];
        el.innerHTML = pills.map(p => `
            <button type="button" class="lk-qb-pill ${state.filter === p.key ? 'is-active' : ''}" data-action="set-filter" data-filter="${p.key}">
                ${esc(p.label)}
            </button>
        `).join('');
    };

    const renderSubtitle = () => {
        const sub = backdrop.querySelector('#lk-qb-subtitle');
        if (!sub) return;
        const chat = currentChat();
        if (!chat) {
            sub.textContent = '当前未打开聊天窗口';
            return;
        }
        const totalBooks = state.books.length;
        const totalEnabled = state.books.reduce((sum, b) => sum + b.enabledCount, 0);
        const totalOverrides = state.books.reduce((sum, b) => sum + b.overrideCount, 0);
        sub.textContent = totalOverrides > 0
            ? `当前聊天已激活 ${totalBooks} 本世界书 · ${totalEnabled} 条启用中（本聊天覆写 ${totalOverrides} 条）`
            : `当前聊天已激活 ${totalBooks} 本世界书 · ${totalEnabled} 条启用中（条目开关仅对当前聊天生效）`;
    };

    const renderBooksList = () => {
        const body = backdrop.querySelector('#lk-qb-body');
        if (!body) return;
        const prevScroll = body.scrollTop;

        if (state.loading) {
            body.innerHTML = `<div class="lk-empty-inline"><i class="fa-solid fa-spinner fa-spin"></i> 正在加载世界书条目...</div>`;
            return;
        }

        const chat = currentChat();
        if (!chat) {
            body.innerHTML = `
                <div class="lk-empty-card">
                    <i class="fa-solid fa-comments lk-empty-icon"></i>
                    <div class="lk-empty-title">请先打开一个角色或群聊窗口</div>
                    <div class="lk-empty-desc">「快速翻书」用于管理当前聊天窗口内生效的世界书与单聊条目开关。</div>
                </div>
            `;
            return;
        }

        if (state.books.length === 0) {
            body.innerHTML = `
                <div class="lk-empty-card">
                    <i class="fa-solid fa-book-open lk-empty-icon"></i>
                    <div class="lk-empty-title">当前聊天暂无激活的世界书</div>
                    <div class="lk-empty-desc">你可以前往「绑定器」为当前预设或当前聊天绑定世界书，或在酒馆世界书面板中启用。</div>
                </div>
            `;
            return;
        }

        const kw = state.search.trim().toLowerCase();
        const cardsHtml = [];

        for (const book of state.books) {
            const bookMatchesKw = !kw || book.name.toLowerCase().includes(kw);
            const filteredEntries = book.entries.filter((e) => {
                if (state.filter === 'enabled' && e.effectiveDisabled) return false;
                if (state.filter === 'overridden' && !e.hasOverride) return false;
                if (!kw) return true;
                if (bookMatchesKw) return true;
                return e.title.toLowerCase().includes(kw)
                    || e.keys.some(k => k.toLowerCase().includes(kw));
            });

            if (kw && !bookMatchesKw && filteredEntries.length === 0) continue;
            if (state.filter === 'overridden' && filteredEntries.length === 0) continue;

            const isExpanded = kw ? true : state.expandedBooks.has(book.name);
            const sourceTagsHtml = book.sources.map((src) => {
                const cls = src === '当前聊天绑定'
                    ? 'is-chat-bound'
                    : src === '预设绑定'
                        ? 'is-preset-bound'
                        : '';
                return `<span class="lk-qb-source ${cls}">${esc(src)}</span>`;
            }).join('');

            const entriesHtml = !book.exists
                ? `<div class="lk-empty-inline">未在酒馆世界书列表中找到「${esc(book.name)}」（可能已被删除或重命名）</div>`
                : filteredEntries.length === 0
                    ? `<div class="lk-empty-inline">${book.entries.length === 0 ? '该世界书暂无条目' : '当前筛选条件下没有匹配的条目'}</div>`
                    : filteredEntries.map((entry) => {
                        const dotCls = entry.triggerType === 'constant'
                            ? 'is-constant'
                            : entry.triggerType === 'vector'
                                ? 'is-vector'
                                : 'is-keyword';
                        const dotTitle = entry.triggerType === 'constant'
                            ? '常驻条目（蓝灯）'
                            : entry.triggerType === 'vector'
                                ? '向量检索条目'
                                : `关键词触发（绿灯）${entry.keys.length ? '：' + entry.keys.slice(0, 5).join(', ') : ''}`;
                        const keysPreview = entry.keys.length > 0 && entry.comment
                            ? `<span class="lk-qb-entry-keys" title="${esc(entry.keys.join(', '))}">${esc(entry.keys.slice(0, 3).join(' · '))}${entry.keys.length > 3 ? '…' : ''}</span>`
                            : '';

                        return `
                            <label class="checkbox_label lk-qb-entry-row ${entry.effectiveDisabled ? 'is-disabled' : ''} ${entry.hasOverride ? 'is-overridden' : ''}">
                                <div class="lk-qb-entry-main">
                                    <span class="lk-qb-lamp ${dotCls}" title="${esc(dotTitle)}"></span>
                                    <div class="lk-qb-entry-text">
                                        <span class="lk-qb-entry-title" title="${esc(entry.title)}">${esc(entry.title)}</span>
                                        ${keysPreview}
                                    </div>
                                    ${entry.hasOverride ? '<span class="lk-mini-tag is-live" title="该条目状态仅在当前聊天窗口生效，不影响原世界书">本聊天已改</span>' : ''}
                                </div>
                                <input type="checkbox"
                                    class="lk-qb-entry-toggle"
                                    data-book="${esc(book.name)}"
                                    data-uid="${esc(entry.uid)}"
                                    ${!entry.effectiveDisabled ? 'checked' : ''} />
                            </label>
                        `;
                    }).join('');

            cardsHtml.push(`
                <div class="lk-qb-book-card ${isExpanded ? 'is-open' : ''}" data-book="${esc(book.name)}">
                    <div class="lk-qb-book-head" data-action="toggle-book" data-book="${esc(book.name)}">
                        <div class="lk-qb-book-left">
                            <i class="fa-solid ${isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'} lk-qb-chevron"></i>
                            <div class="lk-qb-book-info">
                                <div class="lk-qb-book-title-line">
                                    <span class="lk-qb-book-name" title="${esc(book.name)}">${esc(book.name)}</span>
                                    <span class="lk-qb-book-stat">${book.enabledCount}/${book.entries.length}</span>
                                    ${book.overrideCount > 0 ? `<span class="lk-mini-tag is-live">已改 ${book.overrideCount}</span>` : ''}
                                </div>
                                <div class="lk-qb-book-sources">${sourceTagsHtml}</div>
                            </div>
                        </div>
                        <div class="lk-qb-book-actions">
                            ${book.overrideCount > 0 ? `
                                <button type="button" class="menu_button lk-btn lk-btn-xs lk-btn-ghost" data-action="reset-book-overrides" data-book="${esc(book.name)}" title="恢复本书所有条目在当前聊天的默认状态">
                                    <i class="fa-solid fa-rotate-left"></i><span>恢复</span>
                                </button>
                            ` : ''}
                            ${book.isChatBound ? `
                                <button type="button" class="menu_button lk-btn lk-btn-xs lk-btn-danger-ghost" data-action="unbind-chat-book" data-book="${esc(book.name)}" title="从当前聊天绑定中快速解绑此世界书">
                                    <i class="fa-solid fa-link-slash"></i><span>解绑</span>
                                </button>
                            ` : ''}
                        </div>
                    </div>
                    ${isExpanded ? `<div class="lk-qb-entry-list">${entriesHtml}</div>` : ''}
                </div>
            `);
        }

        body.innerHTML = cardsHtml.length > 0
            ? `<div class="lk-qb-book-list">${cardsHtml.join('')}</div>`
            : `<div class="lk-empty-inline">没有符合当前筛选条件的世界书或条目</div>`;

        body.scrollTop = prevScroll;
    };

    const renderAll = () => {
        renderSubtitle();
        renderFilters();
        renderBooksList();
        refreshQuickBookIndicator();
    };

    const reloadData = async () => {
        state.books = await loadActiveBooksWithEntries();
        state.loading = false;
        if (!state.initializedExpand) {
            state.initializedExpand = true;
            // Auto-expand first book (or all if <= 2 books) for immediate ergonomics
            if (state.books.length <= 2) {
                state.books.forEach(b => state.expandedBooks.add(b.name));
            } else if (state.books[0]) {
                state.expandedBooks.add(state.books[0].name);
            }
        }
        renderAll();
    };

    backdrop.addEventListener('click', async (e) => {
        e.stopPropagation();

        if (e.target === backdrop || e.target.closest('.lk-qb-close')) {
            close();
            return;
        }

        const actionEl = e.target.closest('[data-action]');
        if (!actionEl) return;
        const action = actionEl.dataset.action;

        if (action === 'open-main-binder') {
            close();
            openMainPanelHandler?.('current-chat');
            return;
        }

        if (action === 'set-filter') {
            state.filter = actionEl.dataset.filter || 'all';
            renderAll();
            return;
        }

        if (action === 'toggle-book') {
            const bookName = actionEl.dataset.book;
            if (!bookName) return;
            if (state.expandedBooks.has(bookName)) state.expandedBooks.delete(bookName);
            else state.expandedBooks.add(bookName);
            renderBooksList();
            return;
        }

        if (action === 'reset-book-overrides') {
            const bookName = actionEl.dataset.book;
            const chat = currentChat();
            if (!bookName || !chat) return;
            try {
                await resetChatBookEntryOverrides(chat, bookName);
                toastr.info(`已恢复「${bookName}」在当前聊天的默认条目状态`);
                await reloadData();
            } catch (err) {
                toastr.error(err?.message || '恢复默认状态失败');
            }
            return;
        }

        if (action === 'unbind-chat-book') {
            const bookName = actionEl.dataset.book;
            const chat = currentChat();
            if (!bookName || !chat) return;
            try {
                await unbindChatLorebook(chat, bookName);
                syncActivePresetImmediately({ showToast: false });
                const stillSelected = getSelectedWorldInfo().includes(bookName);
                toastr.info(
                    stillSelected
                        ? `已从当前聊天解绑「${bookName}」（因当前预设或全局仍启用该书，暂保持激活）`
                        : `已从当前聊天解绑并关闭「${bookName}」`,
                );
                await reloadData();
            } catch (err) {
                toastr.error(err?.message || '解绑当前聊天世界书失败');
            }
        }
    });

    backdrop.addEventListener('change', async (e) => {
        const t = e.target;
        if (!t.classList.contains('lk-qb-entry-toggle')) return;
        const bookName = t.dataset.book;
        const uid = t.dataset.uid;
        const chat = currentChat();
        if (!bookName || !uid || !chat) return;

        const book = state.books.find(b => b.name === bookName);
        const entry = book?.entries.find(en => en.uid === uid);
        if (!entry) return;

        const nextDisabled = !t.checked;
        const overrideVal = nextDisabled === entry.defaultDisabled ? null : nextDisabled;

        try {
            await saveChatEntryOverride(chat, bookName, uid, overrideVal);
            entry.effectiveDisabled = nextDisabled;
            entry.hasOverride = overrideVal !== null;
            book.overrideCount = book.entries.filter(en => en.hasOverride).length;
            book.enabledCount = book.entries.filter(en => !en.effectiveDisabled).length;
            renderAll();
        } catch (err) {
            t.checked = !entry.effectiveDisabled;
            toastr.error(err?.message || '保存单聊条目状态失败');
        }
    });

    backdrop.addEventListener('input', (e) => {
        if (e.target.id === 'lk-qb-search') {
            state.search = e.target.value;
            renderBooksList();
        }
    });

    document.addEventListener('keydown', onKeyDown);
    document.body.appendChild(backdrop);
    unbindVp = bindViewportPin(backdrop);
    activeQuickModal = { backdrop, close };

    renderAll();
    await reloadData();
}
