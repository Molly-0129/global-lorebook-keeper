// Modernized Binder Management Panel following SillyTavern native theme variables & controls

import {
    applyCurrentChatBinding,
    setOnStateChangedCallback,
    syncActivePresetImmediately,
} from './core.js';
import {
    bindViewportPin,
    esc,
    openSubDialog,
    promptUnsavedChanges,
    shieldDialogEvents,
} from './dialog.js';
import { currentChat, listPresetPrompts, readChatBinding, resolvePreset, saveChatBinding } from './chat.js';
import { scanAllUnboundPresetUpdates } from './matcher.js';
import {
    getActivePresetManager,
    getCurrentCharacter,
    getCurrentPresetName,
    getSelectedWorldInfo,
    getStContext,
    getWorldNames,
} from './st-env.js';
import {
    attachPresetToGroup,
    deleteBindingGroup,
    EXTENSION_DISPLAY_NAME,
    findGroupByPreset,
    getLorebooksForPreset,
    getRainbowColorMeta,
    loadSettings,
    RAINBOW_COLORS,
    saveSettings,
    uniqueStrings,
    upsertBindingGroup,
} from './storage.js';

let activeModal = null;

function serializePlSnapshot({ name = '', color = '', presets = [], lorebooks = [] }) {
    return JSON.stringify({
        name: String(name || '').trim(),
        color: String(color || '').trim(),
        presets: uniqueStrings(presets),
        lorebooks: uniqueStrings(lorebooks),
    });
}

/**
 * Opens the main Binder Management Modal.
 */
export function showSettingsPanel(initialTab = 'preset-lorebook') {
    if (activeModal) {
        activeModal.focusPanel();
        return;
    }

    const presetManager = getActivePresetManager();
    if (!presetManager) {
        toastr.error('当前连接 API 暂不支持预设管理器，请先在酒馆中选择有效的生成 API。');
        return;
    }

    const state = {
        activeTab: initialTab,
        // Tab 1: Preset -> Lorebook Composer
        editingGroupId: null,
        groupName: '',
        groupColor: '',
        selectedPresets: [],
        selectedLorebooks: [],
        showExtraPresetPicker: false,
        lorebookSearch: '',
        ruleSearch: '',
        plBaseline: serializePlSnapshot({}),
        plNotice: '',
        lastSavedGroupId: null,


        // Tab 3: Scan results
        scanResults: null,
    };

    const isPresetComposerDirty = () => {
        const cur = serializePlSnapshot({
            name: state.groupName,
            color: state.groupColor,
            presets: state.selectedPresets,
            lorebooks: state.selectedLorebooks,
        });
        return cur !== state.plBaseline;
    };


    const resetPresetComposer = (notice = '') => {
        state.editingGroupId = null;
        state.groupName = '';
        state.groupColor = '';
        state.selectedPresets = [];
        state.selectedLorebooks = [];
        state.showExtraPresetPicker = false;
        state.plBaseline = serializePlSnapshot({});
        state.plNotice = notice;
    };

    const loadGroupIntoComposer = (grp, notice = '') => {
        state.editingGroupId = grp.id;
        state.groupName = grp.name || '';
        state.groupColor = grp.color || '';
        state.selectedPresets = [...grp.presets];
        state.selectedLorebooks = [...grp.lorebooks];
        state.showExtraPresetPicker = grp.presets.length > 1;
        state.plBaseline = serializePlSnapshot({
            name: grp.name,
            color: grp.color,
            presets: grp.presets,
            lorebooks: grp.lorebooks,
        });
        state.plNotice = notice;
    };


    let draftChat = null;
    let draft = {};
    let savedDraft = '';
    let savingChat = false;

    const loadChatDraft = (chat = currentChat()) => {
        draftChat = chat;
        draft = { mode: 'inherit', preset: '', apiId: '', prompts: {}, lorebooks: [], ...readChatBinding(chat) };
        savedDraft = JSON.stringify(draft);
    };
    loadChatDraft();

    const isChatDirty = () => JSON.stringify(draft) !== savedDraft;
    const isAnyDirty = () => isPresetComposerDirty() || isChatDirty();

    const saveChatDraft = async (binding = draft) => {
        if (savingChat || !draftChat) return false;
        if (binding.mode === 'preset' && !binding.preset) {
            toastr.warning('请先选择聊天预设');
            return false;
        }
        savingChat = true;
        try {
            await saveChatBinding(draftChat, binding);
            loadChatDraft();
            await applyCurrentChatBinding();
            renderAll();
            toastr.success(binding.mode || binding.preset || binding.lorebooks?.length ? '已保存聊天绑定' : '已解除聊天绑定');
            return true;
        } catch (error) {
            toastr.error(error.message || '保存聊天绑定失败');
            return false;
        } finally {
            savingChat = false;
        }
    };

    let editingAvatar = '';
    const renderRoleTab = (env) => {
        const characters = getStContext()?.characters?.filter(c => c?.avatar) || [];
        if (!characters.length) return '<p class="lk-empty-inline">请先导入角色卡。</p>';
        if (!characters.some(c => c.avatar === editingAvatar)) editingAvatar = env.currentChar?.avatar || characters[0].avatar;
        const role = env.settings.characterPresetBindings[editingAvatar];
        const name = typeof role === 'string' ? role : role?.preset;
        return `<div class="lk-settings-card">
            <label for="lk-role-avatar">角色卡</label>
            <select id="lk-role-avatar" class="text_pole lk-select">
                ${characters.map(c => `<option value="${esc(c.avatar)}" ${c.avatar === editingAvatar ? 'selected' : ''}>${esc(c.name || c.avatar)}</option>`).join('')}
            </select>
            <p>当前默认预设：${esc(name || '未绑定')}${role?.apiId ? ' · ' + esc(role.apiId) : ''}</p>
            <label for="lk-role-preset">角色默认预设</label>
            <select id="lk-role-preset" class="text_pole lk-select">
                <option value="">选择预设</option>
                ${env.allPresets.map(p => `<option value="${esc(p)}" ${p === name && (!role?.apiId || role.apiId === env.pm.apiId) ? 'selected' : ''}>${esc(p)}</option>`).join('')}
            </select>
            <button type="button" class="menu_button" data-action="save-role">保存角色绑定</button>
            <button type="button" class="menu_button" data-action="clear-role" ${role ? '' : 'disabled'}>解除角色绑定</button>
        </div>`;
    };

    const renderChatTab = (env) => {
        const chat = currentChat();
        if (!chat) return '<p class="lk-empty-inline">请先打开一条聊天。</p>';
        const apiId = env.pm?.apiId;
        const missingPreset = draft.mode === 'preset' && draft.preset && (!env.allPresets.includes(draft.preset) || draft.apiId !== apiId);
        const presetOptions = [...(missingPreset ? [draft.preset] : []), ...env.allPresets.filter(preset => !missingPreset || preset !== draft.preset)];
        const targetPreset = resolvePreset(draft, apiId, env.settings);
        const prompts = listPresetPrompts(env.pm, targetPreset);
        const scoped = draft.preset === targetPreset && draft.apiId === apiId ? draft.prompts : {};
        const missingPrompts = !missingPreset && Object.keys(scoped).filter(id => !prompts.some(prompt => prompt.identifier === id));
        const allBooks = uniqueStrings([...draft.lorebooks, ...env.allLorebooks]);
        return `
            <div class="lk-settings-card">
                <h3>当前聊天 <span>${esc(chat.name)}</span></h3>
                <label for="lk-chat-mode">预设来源</label>
                <select class="text_pole lk-select" id="lk-chat-mode">
                    <option value="inherit" ${draft.mode === 'inherit' ? 'selected' : ''}>继承角色默认${draft.mode === 'inherit' && targetPreset ? ' · ' + esc(targetPreset) : ''}</option>
                    <option value="preset" ${draft.mode === 'preset' ? 'selected' : ''}>指定聊天预设</option>
                    <option value="manual" ${draft.mode === 'manual' ? 'selected' : ''}>使用手动预设</option>
                </select>
                ${draft.mode === 'preset' ? `<label for="lk-chat-preset">聊天预设</label>
                <select class="text_pole lk-select" id="lk-chat-preset">
                    <option value="">请选择预设</option>
                    ${presetOptions.map(preset => `<option value="${esc(preset)}" ${preset === draft.preset ? 'selected' : ''}>${esc(preset)}${missingPreset && preset === draft.preset ? '（当前不可用）' : ''}</option>`).join('')}
                </select>` : ''}
                ${missingPreset ? '<p>请选择当前 API 可用的预设。</p>' : ''}
                ${missingPrompts?.length ? `<p>找不到条目 ${esc(missingPrompts.join('、'))}。保存时会移除这些条目的覆盖。</p>` : ''}
                ${prompts.length ? '<h4>提示词条目</h4>' : ''}
                ${prompts.map(prompt => `
                    <label class="lk-switch-row">
                        <span>${esc(prompt.name || prompt.identifier)}</span>
                        <select class="text_pole" data-chat-prompt="${esc(prompt.identifier)}">
                            <option value="">沿用预设</option>
                            <option value="on" ${scoped[prompt.identifier] === true ? 'selected' : ''}>开启</option>
                            <option value="off" ${scoped[prompt.identifier] === false ? 'selected' : ''}>关闭</option>
                        </select>
                    </label>`).join('')}
                <h4>额外启用的全局世界书</h4>
                ${allBooks.map(book => `<label class="checkbox_label lk-switch-row">
                    <input type="checkbox" data-chat-book="${esc(book)}" ${draft.lorebooks.includes(book) ? 'checked' : ''} />
                    <span>${esc(book)}${env.allLorebooks.includes(book) ? '' : '（未找到）'}</span>
                </label>`).join('')}
                <div class="lk-drawer-actions">
                    <button type="button" class="menu_button" data-action="clear-chat-binding">解除绑定</button>
                    <button type="button" class="menu_button" data-action="save-chat-binding" ${missingPreset ? 'disabled' : ''}>保存聊天绑定</button>
                </div>
            </div>`;
    };

    const getDraftToSave = () => {
        const pm = getActivePresetManager();
        const target = resolvePreset(draft, pm?.apiId);
        const ids = new Set(listPresetPrompts(pm, target).map(prompt => prompt.identifier));
        return {
            ...draft,
            prompts: draft.preset === target && draft.apiId === pm?.apiId
                ? Object.fromEntries(Object.entries(draft.prompts).filter(([id]) => ids.has(id))) : {},
        };
    };

    const backdrop = document.createElement('div');
    backdrop.id = 'lk-modal-backdrop';
    backdrop.className = 'lk-backdrop ui-widget';
    backdrop.innerHTML = `
        <div class="lk-modal" role="dialog" aria-modal="true" aria-labelledby="lk-modal-title">
            <div class="lk-header">
                <div class="lk-header-title-wrap">
                    <span class="lk-logo-badge"><i class="fa-solid fa-link"></i></span>
                    <div>
                        <h2 id="lk-modal-title" class="lk-title">${esc(EXTENSION_DISPLAY_NAME)}</h2>
                        <div class="lk-subtitle">管理聊天、预设与全局世界书的绑定</div>
                    </div>
                </div>
                <button type="button" class="lk-icon-close lk-main-close" title="关闭面板 (Esc)">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <div class="lk-status-bar" id="lk-status-bar"></div>

            <div class="lk-tabs" role="tablist" id="lk-tabs"></div>

            <div class="lk-body" id="lk-body"></div>
        </div>
    `;

    shieldDialogEvents(backdrop);

    const getLiveEnvData = () => {
        const pm = getActivePresetManager();
        const allPresets = uniqueStrings(pm?.getAllPresets?.() || []);
        const allLorebooks = uniqueStrings(getWorldNames());
        const activeLorebooks = uniqueStrings(getSelectedWorldInfo());
        const currentPreset = getCurrentPresetName();
        const currentChar = getCurrentCharacter();
        const ctx = getStContext();
        const settings = loadSettings();
        return {
            pm,
            allPresets,
            allLorebooks,
            activeLorebooks,
            currentPreset,
            currentChar,
            settings,
        };
    };

    const performSavePresetBinding = () => {
        const presets = uniqueStrings(state.selectedPresets);
        const lorebooks = uniqueStrings(state.selectedLorebooks);

        if (presets.length === 0) {
            toastr.warning('请先在第一步中选择至少一个预设。');
            return false;
        }
        if (lorebooks.length === 0) {
            toastr.warning('请在第二步中勾选至少一本要绑定的世界书。');
            return false;
        }

        const beforeSettings = loadSettings();
        const activePreset = getCurrentPresetName();
        const prevActiveBooks = activePreset ? getLorebooksForPreset(beforeSettings, activePreset) : [];

        const { group, movedPresets } = upsertBindingGroup({
            groupId: state.editingGroupId,
            name: state.groupName,
            color: state.groupColor,
            presets,
            lorebooks,
        });

        state.lastSavedGroupId = group.id;
        resetPresetComposer('');

        const wasActiveInvolved = activePreset && (presets.includes(activePreset) || prevActiveBooks.length > 0);
        let syncMsg = '';
        if (wasActiveInvolved) {
            const syncRes = syncActivePresetImmediately();
            if (syncRes.isActivePreset && presets.includes(activePreset)) {
                syncMsg = `，当前全局世界书已即时同步（启用 ${syncRes.activatedValid.length} 本）`;
            }
        }

        const movedMsg = movedPresets.length > 0
            ? `（已将「${movedPresets.join('、')}」从旧规则并入此组）`
            : '';

        const displayTitle = group.name
            ? `绑定「${group.name}」`
            : presets.length === 1
                ? `「${presets[0]}」`
                : `「${presets[0]}」等 ${presets.length} 个预设`;
        toastr.success(`已保存 ${displayTitle}（共 ${lorebooks.length} 本世界书）${movedMsg}${syncMsg}`);

        syncExtensionDrawerSummary();
        renderAll();
        return true;
    };


    const confirmOrResolveDirty = async (contextDesc) => {
        if (isPresetComposerDirty()) {
            const action = await promptUnsavedChanges(contextDesc || '「预设 ↔ 世界书」编辑区有未保存的绑定配置');
            if (action === 'cancel') return false;
            if (action === 'save') {
                return performSavePresetBinding();
            }
            resetPresetComposer();
            return true;
        }
        if (isChatDirty()) {
            const action = await promptUnsavedChanges('当前聊天还有未保存的绑定配置');
            if (action === 'cancel') return false;
            if (action === 'save') return saveChatDraft(getDraftToSave());
            loadChatDraft();
        }
        return true;
    };

    // Selective sync for dirty footer & save button when typing custom name without re-rendering input DOM
    const refreshPlFooterStateOnly = () => {
        const dirty = isPresetComposerDirty();
        const isEditing = Boolean(state.editingGroupId);
        const indicator = backdrop.querySelector('#lk-pl-dirty-indicator');
        if (indicator) {
            indicator.innerHTML = dirty
                ? '<span class="lk-dirty-dot"></span><span>有未保存的修改，点击右侧按钮保存生效</span>'
                : '<span class="lk-muted-hint">保存后若该预设正在使用，将立即同步全局世界书</span>';
        }
        const resetBtn = backdrop.querySelector('#lk-pl-reset-btn');
        if (resetBtn) {
            resetBtn.style.display = (dirty || isEditing) ? '' : 'none';
        }
    };

    const renderStatusBar = (env) => {
        const bar = backdrop.querySelector('#lk-status-bar');
        if (!bar) return;

        const activeGroup = env.currentPreset ? findGroupByPreset(env.settings, env.currentPreset) : null;
        const boundCount = activeGroup ? activeGroup.lorebooks.length : 0;
        const activeColorMeta = activeGroup ? getRainbowColorMeta(activeGroup.color) : null;
        const colorDotHtml = activeColorMeta
            ? `<span class="lk-color-dot" style="--dot-color:${activeColorMeta.hex};"></span>`
            : '';
        const groupTitleSuffix = activeGroup?.name ? ` · ${esc(activeGroup.name)}` : '';

        const presetStatusBadge = !env.currentPreset
            ? '<span class="lk-badge is-muted">无预设</span>'
            : activeGroup
                ? `<span class="lk-badge is-ok">${colorDotHtml}<i class="fa-solid fa-shield-halved"></i>已绑 ${boundCount} 本${groupTitleSuffix}</span>`
                : '<span class="lk-badge is-muted">未绑定</span>';

        let quickActionHtml = '';
        if (env.currentPreset && !activeGroup) {
            quickActionHtml = `
                <button type="button" class="menu_button lk-btn lk-btn-xs lk-btn-accent-soft" data-action="quick-fill-current" title="将当前预设与当前全局已启用的世界书一键填入下方工作台">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>快速绑定当前状态</span>
                </button>
            `;
        } else if (env.currentPreset && activeGroup) {
            quickActionHtml = `
                <button type="button" class="menu_button lk-btn lk-btn-xs lk-btn-ghost" data-action="quick-edit-current" data-group-id="${esc(activeGroup.id)}">
                    <i class="fa-solid fa-pen-to-square"></i>
                    <span>编辑当前绑定</span>
                </button>
            `;
        }

        bar.innerHTML = `
            <div class="lk-status-items">
                <div class="lk-status-item">
                    <span class="lk-status-label">当前预设</span>
                    <span class="lk-status-val" title="${esc(env.currentPreset || '未选择')}">${esc(env.currentPreset || '未选择')}</span>
                    ${presetStatusBadge}
                </div>
                <span class="lk-status-sep"></span>
                <div class="lk-status-item">
                    <span class="lk-status-label">当前角色</span>
                    <span class="lk-status-val" title="${esc(env.currentChar?.name || '未在单人角色聊天中')}">${esc(env.currentChar?.name || '未选择')}</span>
                </div>
                <span class="lk-status-sep"></span>
                <div class="lk-status-item">
                    <span class="lk-status-label">全局世界书</span>
                    <span class="lk-status-val">已启用 ${env.activeLorebooks.length} 本</span>
                </div>
            </div>
            <div class="lk-status-actions">${quickActionHtml}</div>
        `;
    };

    const renderTabs = (env) => {
        const tabsEl = backdrop.querySelector('#lk-tabs');
        if (!tabsEl) return;

        const plCount = env.settings.bindingGroups.length;
        const autoOn = Boolean(env.settings.options.autoBindPresetUpdate);

        tabsEl.innerHTML = `
            <button type="button" role="tab" class="lk-tab ${state.activeTab === 'preset-lorebook' ? 'is-active' : ''}" data-tab="preset-lorebook">
                <i class="fa-solid fa-book-bookmark"></i>
                <span>预设 ↔ 世界书</span>
                <span class="lk-tab-count">${plCount}</span>
            </button>
            <button type="button" role="tab" class="lk-tab ${state.activeTab === 'role-binding' ? 'is-active' : ''}" data-tab="role-binding">
                <i class="fa-solid fa-user-tag"></i><span>角色 ↔ 预设</span>
            </button>
            <button type="button" role="tab" class="lk-tab ${state.activeTab === 'chat-binding' ? 'is-active' : ''}" data-tab="chat-binding">
                <i class="fa-solid fa-comments"></i>
                <span>当前聊天</span>
            </button>
            <button type="button" role="tab" class="lk-tab ${state.activeTab === 'settings' ? 'is-active' : ''}" data-tab="settings">
                <i class="fa-solid fa-sliders"></i>
                <span>更新识别与设置</span>
                ${autoOn ? '<span class="lk-tab-dot" title="已开启新版预设自动继承"></span>' : ''}
            </button>
        `;
    };

    const renderPresetLorebookTab = (env) => {
        const isEditing = Boolean(state.editingGroupId);
        const dirty = isPresetComposerDirty();
        const presetSet = new Set(env.allPresets);
        const worldSet = new Set(env.allLorebooks);
        const activeWorldSet = new Set(env.activeLorebooks);

        const primaryPreset = state.selectedPresets[0] || '';
        const extraPresets = state.selectedPresets.slice(1);

        const mainPresetOptions = [
            `<option value="">-- 请选择要绑定的预设 --</option>`,
            ...(primaryPreset && !presetSet.has(primaryPreset)
                ? [`<option value="${esc(primaryPreset)}" selected>${esc(primaryPreset)} (未找到)</option>`]
                : []),
            ...env.allPresets.map((p) => {
                const existingGrp = findGroupByPreset(env.settings, p);
                const suffix = existingGrp && existingGrp.id !== state.editingGroupId
                    ? ` · 已绑${existingGrp.name ? `「${existingGrp.name}」` : ` ${existingGrp.lorebooks.length} 本`}`
                    : '';
                return `<option value="${esc(p)}" ${p === primaryPreset ? 'selected' : ''}>${esc(p)}${esc(suffix)}</option>`;
            }),
        ].join('');

        const availableExtraPresets = env.allPresets.filter(p => !state.selectedPresets.includes(p));
        const extraPresetHtml = state.selectedPresets.length > 0 ? `
            <div class="lk-extra-presets-area">
                ${extraPresets.length > 0 ? `
                    <div class="lk-chip-wrap">
                        <span class="lk-inline-hint">共用此组世界书的所有预设：</span>
                        ${state.selectedPresets.map((p) => {
                            const exists = presetSet.has(p);
                            return `
                                <span class="lk-chip is-preset ${exists ? '' : 'is-missing'}">
                                    <i class="fa-solid fa-sliders"></i>
                                    <span>${esc(p)}${exists ? '' : ' (预设不存在)'}</span>
                                    <button type="button" class="lk-chip-remove" data-action="remove-preset-chip" data-preset="${esc(p)}" title="移出此预设">&times;</button>
                                </span>
                            `;
                        }).join('')}
                    </div>
                ` : ''}
                ${state.showExtraPresetPicker ? `
                    <div class="lk-extra-picker-row">
                        <select class="text_pole lk-select lk-select-sm" id="lk-extra-preset-select">
                            <option value="">-- 选择另一个共用同组世界书的预设（如新版/分支） --</option>
                            ${availableExtraPresets.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}
                        </select>
                        <button type="button" class="menu_button lk-btn lk-btn-xs lk-btn-ghost" data-action="hide-extra-preset-picker">收起</button>
                    </div>
                ` : `
                    <button type="button" class="lk-link-btn" data-action="show-extra-preset-picker">
                        <i class="fa-solid fa-plus"></i> 添加共用同一组世界书的其他预设（如多版本共存）
                    </button>
                `}
            </div>
        ` : '';

        // 7 Rainbow Color Swatches + Clear swatch
        const colorSwatchesHtml = `
            <div class="lk-color-picker" role="radiogroup" aria-label="绑定颜色标记">
                <button type="button"
                    class="lk-swatch lk-swatch-none ${!state.groupColor ? 'is-selected' : ''}"
                    data-action="pick-group-color"
                    data-color=""
                    title="无颜色标记">
                    <i class="fa-solid fa-ban"></i>
                </button>
                ${RAINBOW_COLORS.map(c => `
                    <button type="button"
                        class="lk-swatch ${state.groupColor === c.key ? 'is-selected' : ''}"
                        style="--swatch-color: ${c.hex};"
                        data-action="pick-group-color"
                        data-color="${c.key}"
                        title="${c.label}色标记${state.groupColor === c.key ? '（再次点击取消）' : ''}">
                        ${state.groupColor === c.key ? '<i class="fa-solid fa-check"></i>' : ''}
                    </button>
                `).join('')}
            </div>
        `;

        // Filter lorebooks for checklist
        const kw = state.lorebookSearch.trim().toLowerCase();
        const combinedBooks = uniqueStrings([...state.selectedLorebooks, ...env.allLorebooks]);
        const missingSelectedBooks = state.selectedLorebooks.filter(b => !worldSet.has(b));
        const orderedBooks = [...missingSelectedBooks, ...env.allLorebooks];
        const filteredBooks = kw
            ? orderedBooks.filter(b => b.toLowerCase().includes(kw))
            : orderedBooks;

        const checklistHtml = combinedBooks.length === 0
            ? `<div class="lk-empty-inline">当前酒馆中还没有任何世界书，请先在酒馆「世界书」面板导入或创建。</div>`
            : filteredBooks.length === 0
                ? `<div class="lk-empty-inline">没有匹配「${esc(state.lorebookSearch)}」的世界书</div>`
                : filteredBooks.map((book) => {
                    const checked = state.selectedLorebooks.includes(book);
                    const exists = worldSet.has(book);
                    const isGlobalActive = activeWorldSet.has(book);
                    return `
                        <label class="checkbox_label lk-book-item ${checked ? 'is-checked' : ''} ${exists ? '' : 'is-missing'}" title="${esc(book)}">
                            <input type="checkbox" class="lk-book-checkbox" value="${esc(book)}" ${checked ? 'checked' : ''} />
                            <span class="lk-book-name">${esc(book)}</span>
                            ${!exists ? '<span class="lk-mini-tag is-warn">未找到</span>' : isGlobalActive ? '<span class="lk-mini-tag is-live" title="当前全局已启用">启用中</span>' : ''}
                        </label>
                    `;
                }).join('');

        const selectedBookChipsHtml = state.selectedLorebooks.length > 0 ? `
            <div class="lk-selected-summary">
                <div class="lk-chip-wrap">
                    ${state.selectedLorebooks.map((b) => {
                        const exists = worldSet.has(b);
                        return `
                            <span class="lk-chip ${exists ? '' : 'is-missing'}">
                                <i class="fa-solid fa-book-atlas"></i>
                                <span>${esc(b)}${exists ? '' : ' (未找到)'}</span>
                                <button type="button" class="lk-chip-remove" data-action="remove-book-chip" data-book="${esc(b)}" title="取消勾选">&times;</button>
                            </span>
                        `;
                    }).join('')}
                </div>
            </div>
        ` : '';

        // Saved Binding Groups List
        const rkw = state.ruleSearch.trim().toLowerCase();
        const filteredGroups = rkw
            ? env.settings.bindingGroups.filter((g) => {
                const colorMeta = getRainbowColorMeta(g.color);
                return (g.name && g.name.toLowerCase().includes(rkw))
                    || (colorMeta && colorMeta.label.includes(rkw))
                    || g.presets.some(p => p.toLowerCase().includes(rkw))
                    || g.lorebooks.some(b => b.toLowerCase().includes(rkw));
            })
            : env.settings.bindingGroups;

        const savedCardsHtml = env.settings.bindingGroups.length === 0
            ? `
                <div class="lk-empty-card">
                    <i class="fa-solid fa-layer-group lk-empty-icon"></i>
                    <div class="lk-empty-title">还没有预设与世界书绑定</div>
                    <div class="lk-empty-desc">在上方依次「选定预设 → 勾选世界书 → 点击保存绑定」，以后每次切换到该预设时就会自动启用对应的世界书。</div>
                </div>
            `
            : filteredGroups.length === 0
                ? `<div class="lk-empty-inline">没有匹配「${esc(state.ruleSearch)}」的绑定记录</div>`
                : filteredGroups.map((grp) => {
                    const isBeingEdited = state.editingGroupId === grp.id;
                    const isJustSaved = state.lastSavedGroupId === grp.id;
                    const isCurrentActive = env.currentPreset && grp.presets.includes(env.currentPreset);
                    const colorMeta = getRainbowColorMeta(grp.color);
                    const cardStyle = colorMeta ? `style="--lk-tag-color: ${colorMeta.hex};"` : '';

                    const headerBadgeHtml = (grp.name || colorMeta) ? `
                        <div class="lk-rule-title-row">
                            ${colorMeta ? `<span class="lk-color-dot" style="--dot-color: ${colorMeta.hex};" title="${colorMeta.label}色标记"></span>` : ''}
                            ${grp.name ? `<span class="lk-rule-custom-name">${esc(grp.name)}</span>` : ''}
                        </div>
                    ` : '';

                    const presetBadges = grp.presets.map((p) => {
                        const exists = presetSet.has(p);
                        const isCur = p === env.currentPreset;
                        return `
                            <span class="lk-rule-preset ${isCur ? 'is-current' : ''} ${exists ? '' : 'is-missing'}">
                                <i class="fa-solid ${isCur ? 'fa-circle-check' : 'fa-sliders'}"></i>
                                <span>${esc(p)}</span>
                                ${isCur ? '<em>当前</em>' : !exists ? '<em>未找到</em>' : ''}
                            </span>
                        `;
                    }).join('');

                    const bookPills = grp.lorebooks.map((b) => {
                        const exists = worldSet.has(b);
                        return `<span class="lk-rule-book ${exists ? '' : 'is-missing'}">${esc(b)}${exists ? '' : ' (未找到)'}</span>`;
                    }).join('');

                    return `
                        <div class="lk-rule-card ${colorMeta ? 'has-tag-color' : ''} ${isBeingEdited ? 'is-editing' : ''} ${isJustSaved ? 'is-flash' : ''} ${isCurrentActive ? 'is-active-group' : ''}" ${cardStyle} data-group-id="${esc(grp.id)}">
                            <div class="lk-rule-content">
                                ${headerBadgeHtml}
                                <div class="lk-rule-main">
                                    <div class="lk-rule-presets">${presetBadges}</div>
                                    <div class="lk-rule-arrow"><i class="fa-solid fa-arrow-right-long"></i></div>
                                    <div class="lk-rule-books">${bookPills}</div>
                                </div>
                            </div>
                            <div class="lk-rule-actions">
                                <button type="button" class="menu_button lk-btn lk-btn-xs lk-btn-ghost" data-action="apply-group-now" data-group-id="${esc(grp.id)}" title="立即切换到此预设并启用绑定的世界书">
                                    <i class="fa-solid fa-bolt"></i><span>套用</span>
                                </button>
                                <button type="button" class="menu_button lk-btn lk-btn-xs lk-btn-secondary" data-action="edit-group" data-group-id="${esc(grp.id)}" title="加载到上方编辑区修改名称、颜色或世界书">
                                    <i class="fa-solid fa-pen"></i><span>编辑</span>
                                </button>
                                <button type="button" class="menu_button lk-btn lk-btn-xs lk-btn-danger-ghost" data-action="delete-group" data-group-id="${esc(grp.id)}" title="删除此绑定关系">
                                    <i class="fa-solid fa-trash-can"></i>
                                </button>
                            </div>
                        </div>
                    `;
                }).join('');

        return `
            <div class="lk-section">
                <div class="lk-composer ${isEditing ? 'is-editing-mode' : ''}">
                    <div class="lk-composer-head">
                        <div class="lk-composer-title">
                            <span class="lk-mode-pill ${isEditing ? 'is-edit' : 'is-new'}">${isEditing ? '编辑模式' : '新建绑定'}</span>
                            <span>${isEditing ? '修改绑定关系的预设、世界书、名称或颜色标记' : '按步骤配置预设与世界书联动'}</span>
                        </div>
                        ${isEditing ? `
                            <button type="button" class="menu_button lk-btn lk-btn-xs lk-btn-ghost" data-action="cancel-pl-edit">
                                <i class="fa-solid fa-rotate-left"></i><span>退出编辑</span>
                            </button>
                        ` : ''}
                    </div>

                    ${state.plNotice ? `<div class="lk-inline-banner"><i class="fa-solid fa-circle-info"></i><span>${esc(state.plNotice)}</span></div>` : ''}

                    <div class="lk-step">
                        <div class="lk-step-head">
                            <label class="lk-step-label" for="lk-main-preset-select">
                                <span class="lk-step-num">1</span>选定预设
                            </label>
                            ${env.currentPreset ? `
                                <button type="button" class="lk-link-btn" data-action="pick-current-preset">
                                    填入当前预设「${esc(env.currentPreset)}」
                                </button>
                            ` : ''}
                        </div>
                        <select id="lk-main-preset-select" class="text_pole lk-select">
                            ${mainPresetOptions}
                        </select>
                        ${extraPresetHtml}
                    </div>

                    <div class="lk-step">
                        <div class="lk-step-head">
                            <div class="lk-step-label">
                                <span class="lk-step-num">2</span>勾选要启用的世界书
                                <span class="lk-count-pill ${state.selectedLorebooks.length > 0 ? 'has-val' : ''}">已选 ${state.selectedLorebooks.length} 本</span>
                            </div>
                            <div class="lk-step-tools">
                                ${env.activeLorebooks.length > 0 ? `
                                    <button type="button" class="lk-link-btn" data-action="fill-active-books">填入当前已开 (${env.activeLorebooks.length})</button>
                                ` : ''}
                                ${state.selectedLorebooks.length > 0 ? `
                                    <button type="button" class="lk-link-btn is-muted" data-action="clear-selected-books">清空已选</button>
                                ` : ''}
                            </div>
                        </div>

                        <div class="lk-search-box">
                            <i class="fa-solid fa-magnifying-glass"></i>
                            <input type="search" id="lk-book-search" class="text_pole lk-search-input" placeholder="搜索世界书名称..." value="${esc(state.lorebookSearch)}" />
                            ${state.lorebookSearch ? `<button type="button" class="lk-search-clear" data-action="clear-book-search" title="清除搜索">&times;</button>` : ''}
                        </div>

                        ${selectedBookChipsHtml}

                        <div class="lk-book-grid" id="lk-book-grid">
                            ${checklistHtml}
                        </div>
                    </div>

                    <div class="lk-meta-row">
                        <div class="lk-meta-name-col">
                            <label class="lk-meta-label" for="lk-group-name-input">绑定名称<span>（选填）</span></label>
                            <input type="text" id="lk-group-name-input" class="text_pole lk-input" maxlength="40" placeholder="例如：长篇世界观组 / 现代日常包..." value="${esc(state.groupName)}" />
                        </div>
                        <div class="lk-meta-color-col">
                            <div class="lk-meta-label">颜色标记<span>（7 色可选）</span></div>
                            ${colorSwatchesHtml}
                        </div>
                    </div>

                    <div class="lk-composer-footer">
                        <div class="lk-dirty-indicator" id="lk-pl-dirty-indicator">
                            ${dirty ? '<span class="lk-dirty-dot"></span><span>有未保存的修改，点击右侧按钮保存生效</span>' : '<span class="lk-muted-hint">保存后若该预设正在使用，将立即同步全局世界书</span>'}
                        </div>
                        <div class="lk-composer-btns">
                            <button type="button" id="lk-pl-reset-btn" class="menu_button lk-btn lk-btn-secondary" data-action="reset-pl-composer" style="${(dirty || isEditing) ? '' : 'display:none;'}">
                                <span>${isEditing ? '取消修改' : '重置'}</span>
                            </button>
                            <button type="button" class="menu_button lk-btn lk-btn-primary ${state.selectedPresets.length && state.selectedLorebooks.length ? '' : 'is-incomplete'}" data-action="save-pl-binding">
                                <i class="fa-solid fa-check"></i>
                                <span>${isEditing ? '保存修改' : '保存绑定'}</span>
                            </button>
                        </div>
                    </div>
                </div>

                <div class="lk-list-section">
                    <div class="lk-list-header">
                        <div class="lk-list-title">已保存的绑定关系 <span>(${env.settings.bindingGroups.length})</span></div>
                        ${env.settings.bindingGroups.length >= 3 ? `
                            <div class="lk-search-box lk-search-sm">
                                <i class="fa-solid fa-magnifying-glass"></i>
                                <input type="search" id="lk-rule-search" class="text_pole lk-search-input" placeholder="筛选名称、预设或世界书..." value="${esc(state.ruleSearch)}" />
                            </div>
                        ` : ''}
                    </div>
                    <div class="lk-rule-list">
                        ${savedCardsHtml}
                    </div>
                </div>
            </div>
        `;
    };


    const renderSettingsTab = (env) => {
        const opts = env.settings.options;
        const ignored = env.settings.ignoredUpdatePresets || [];

        let scanHtml = '';
        if (Array.isArray(state.scanResults)) {
            if (state.scanResults.length === 0) {
                scanHtml = `<div class="lk-scan-empty"><i class="fa-solid fa-circle-check"></i> 扫描完成：当前预设列表中没有未绑定的近似新版预设。</div>`;
            } else {
                scanHtml = `
                    <div class="lk-scan-results">
                        <div class="lk-scan-head">
                            <span>发现 ${state.scanResults.length} 个疑似新版预设：</span>
                            ${state.scanResults.length > 1 ? `
                                <button type="button" class="menu_button lk-btn lk-btn-xs lk-btn-primary" data-action="bind-all-scanned">
                                    <i class="fa-solid fa-check-double"></i><span>全部一键继承</span>
                                </button>
                            ` : ''}
                        </div>
                        ${state.scanResults.map((item) => {
                            const cMeta = getRainbowColorMeta(item.group.color);
                            const grpTag = item.group.name ? `（${esc(item.group.name)}）` : '';
                            return `
                                <div class="lk-scan-row">
                                    <div class="lk-scan-info">
                                        <b>${esc(item.candidatePreset)}</b>
                                        <span class="lk-muted-hint">${cMeta ? `<span class="lk-color-dot" style="--dot-color:${cMeta.hex};"></span>` : ''}匹配自「${esc(item.matchedPreset)}」${grpTag} · 共 ${item.group.lorebooks.length} 本世界书</span>
                                    </div>
                                    <div class="lk-scan-actions">
                                        <button type="button" class="menu_button lk-btn lk-btn-xs lk-btn-primary" data-action="bind-scanned-one" data-preset="${esc(item.candidatePreset)}" data-group-id="${esc(item.group.id)}">
                                            <span>并入绑定</span>
                                        </button>
                                        <button type="button" class="menu_button lk-btn lk-btn-xs lk-btn-ghost" data-action="ignore-scanned-one" data-preset="${esc(item.candidatePreset)}">
                                            <span>忽略</span>
                                        </button>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
            }
        }

        // Uses pure SillyTavern native `input[type="checkbox"]` so global ST CSS / custom user themes style it natively
        return `
            <div class="lk-section lk-settings-section">
                <div class="lk-settings-card">
                    <div class="lk-settings-group-title">预设更新识别与继承</div>

                    <label class="checkbox_label lk-switch-row">
                        <div class="lk-switch-text">
                            <div class="lk-switch-title">自动将新版预设绑定到旧关系</div>
                            <div class="lk-switch-desc">导入或切换到名称近似的新版预设（例如 <code>v1.1 → v1.2</code>、同名覆盖、带日期后缀）时，无需询问直接并入原世界书绑定组并保持世界书开启。默认关闭。</div>
                        </div>
                        <input type="checkbox" class="lk-opt-checkbox" data-opt="autoBindPresetUpdate" ${opts.autoBindPresetUpdate ? 'checked' : ''} />
                    </label>

                    <label class="checkbox_label lk-switch-row ${opts.autoBindPresetUpdate ? 'is-dimmed' : ''}">
                        <div class="lk-switch-text">
                            <div class="lk-switch-title">识别到疑似新版预设时弹窗询问</div>
                            <div class="lk-switch-desc">${opts.autoBindPresetUpdate ? '已开启上方自动绑定，新版预设将直接静默继承并弹出通知。' : '当自动绑定关闭时，若切换到与已绑定预设名称近似的新预设，弹窗提示你是否一键继承世界书，防止忘记绑定掉世界书。'}</div>
                        </div>
                        <input type="checkbox" class="lk-opt-checkbox" data-opt="promptOnPresetUpdate" ${opts.promptOnPresetUpdate !== false ? 'checked' : ''} ${opts.autoBindPresetUpdate ? 'disabled' : ''} />
                    </label>

                </div>

                <div class="lk-settings-card">
                    <div class="lk-settings-group-title">通知与反馈</div>
                    <label class="checkbox_label lk-switch-row">
                        <div class="lk-switch-text">
                            <div class="lk-switch-title">切换时显示右上角提醒</div>
                            <div class="lk-switch-desc">自动启用或撤下世界书时，弹出简短 Toast 状态提示（缺失世界书的警告始终保留）。</div>
                        </div>
                        <input type="checkbox" class="lk-opt-checkbox" data-opt="notifyOnSwitch" ${opts.notifyOnSwitch !== false ? 'checked' : ''} />
                    </label>
                </div>

                <div class="lk-settings-card">
                    <div class="lk-settings-group-title">手动扫描与忽略管理</div>
                    <div class="lk-tool-row">
                        <div class="lk-switch-text">
                            <div class="lk-switch-title">扫描当前未绑定的新版预设</div>
                            <div class="lk-switch-desc">立即检查当前 API 下所有预设，找出与现有绑定名称近似但尚未绑定的预设版本。</div>
                        </div>
                        <button type="button" class="menu_button lk-btn lk-btn-secondary" data-action="run-update-scan">
                            <i class="fa-solid fa-magnifying-glass"></i>
                            <span>立即扫描</span>
                        </button>
                    </div>
                    ${scanHtml}

                    ${ignored.length > 0 ? `
                        <div class="lk-ignored-box">
                            <div class="lk-ignored-head">
                                <span>已设为「不再提醒」的预设 (${ignored.length})</span>
                                <button type="button" class="lk-link-btn is-muted" data-action="clear-all-ignored">全部恢复提醒</button>
                            </div>
                            <div class="lk-chip-wrap">
                                ${ignored.map(p => `
                                    <span class="lk-chip">
                                        <span>${esc(p)}</span>
                                        <button type="button" class="lk-chip-remove" data-action="remove-ignored-one" data-preset="${esc(p)}" title="恢复提醒">&times;</button>
                                    </span>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    };

    const renderBody = (env) => {
        const body = backdrop.querySelector('#lk-body');
        if (!body) return;

        if (state.activeTab === 'preset-lorebook') {
            body.innerHTML = renderPresetLorebookTab(env);
        } else if (state.activeTab === 'role-binding') {
            body.innerHTML = renderRoleTab(env);
        } else if (state.activeTab === 'chat-binding') {
            body.innerHTML = renderChatTab(env);
        } else {
            body.innerHTML = renderSettingsTab(env);
        }
    };

    const renderAll = () => {
        if (draftChat?.key !== currentChat()?.key && (draftChat || currentChat())) loadChatDraft();
        const env = getLiveEnvData();
        renderStatusBar(env);
        renderTabs(env);
        renderBody(env);

        if (state.lastSavedGroupId) {
            setTimeout(() => {
                state.lastSavedGroupId = null;
            }, 900);
        }
    };

    const refreshBookGridOnly = () => {
        const env = getLiveEnvData();
        const grid = backdrop.querySelector('#lk-book-grid');
        if (!grid) return;
        const worldSet = new Set(env.allLorebooks);
        const activeWorldSet = new Set(env.activeLorebooks);
        const kw = state.lorebookSearch.trim().toLowerCase();
        const missingSelectedBooks = state.selectedLorebooks.filter(b => !worldSet.has(b));
        const orderedBooks = [...missingSelectedBooks, ...env.allLorebooks];
        const filteredBooks = kw
            ? orderedBooks.filter(b => b.toLowerCase().includes(kw))
            : orderedBooks;

        if (orderedBooks.length === 0) {
            grid.innerHTML = `<div class="lk-empty-inline">当前酒馆中还没有任何世界书。</div>`;
        } else if (filteredBooks.length === 0) {
            grid.innerHTML = `<div class="lk-empty-inline">没有匹配「${esc(state.lorebookSearch)}」的世界书</div>`;
        } else {
            grid.innerHTML = filteredBooks.map((book) => {
                const checked = state.selectedLorebooks.includes(book);
                const exists = worldSet.has(book);
                const isGlobalActive = activeWorldSet.has(book);
                return `
                    <label class="checkbox_label lk-book-item ${checked ? 'is-checked' : ''} ${exists ? '' : 'is-missing'}" title="${esc(book)}">
                        <input type="checkbox" class="lk-book-checkbox" value="${esc(book)}" ${checked ? 'checked' : ''} />
                        <span class="lk-book-name">${esc(book)}</span>
                        ${!exists ? '<span class="lk-mini-tag is-warn">未找到</span>' : isGlobalActive ? '<span class="lk-mini-tag is-live">启用中</span>' : ''}
                    </label>
                `;
            }).join('');
        }
    };

    let unbindVp = null;
    let isClosing = false;

    const requestCloseModal = async () => {
        if (isClosing) return;
        const canProceed = await confirmOrResolveDirty('你有尚未保存的绑定修改');
        if (!canProceed) return;

        isClosing = true;
        document.removeEventListener('keydown', onKeyDown);
        setOnStateChangedCallback(null);
        unbindVp?.();
        activeModal = null;
        backdrop.classList.add('is-closing');
        setTimeout(() => backdrop.remove(), 140);
    };

    const onKeyDown = (e) => {
        if (e.key === 'Escape') {
            if (document.querySelector('.lk-backdrop-sub')) return;
            e.preventDefault();
            e.stopPropagation();
            requestCloseModal();
        }
    };

    backdrop.addEventListener('click', async (e) => {
        e.stopPropagation();

        if (e.target === backdrop || e.target.closest('.lk-main-close')) {
            await requestCloseModal();
            return;
        }

        const tabBtn = e.target.closest('.lk-tab[data-tab]');
        if (tabBtn) {
            const nextTab = tabBtn.dataset.tab;
            if (nextTab && nextTab !== state.activeTab) {
                const ok = await confirmOrResolveDirty();
                if (!ok) return;
                state.activeTab = nextTab;
                state.scanResults = null;
                renderAll();
            }
            return;
        }

        const actionEl = e.target.closest('[data-action]');
        if (!actionEl) return;
        const action = actionEl.dataset.action;

        switch (action) {
            case 'quick-fill-current': {
                const ok = await confirmOrResolveDirty();
                if (!ok) return;
                const env = getLiveEnvData();
                state.activeTab = 'preset-lorebook';
                state.editingGroupId = null;
                state.groupName = '';
                state.groupColor = '';
                state.selectedPresets = env.currentPreset ? [env.currentPreset] : [];
                state.selectedLorebooks = [...env.activeLorebooks];
                state.showExtraPresetPicker = false;
                state.plNotice = env.activeLorebooks.length > 0
                    ? `已填入当前预设「${env.currentPreset}」及当前全局开启的 ${env.activeLorebooks.length} 本世界书，确认无误后点击「保存绑定」即可。`
                    : `已选定当前预设「${env.currentPreset}」，请在第二步勾选需要绑定的世界书后保存。`;
                renderAll();
                break;
            }

            case 'quick-edit-current': {
                const ok = await confirmOrResolveDirty();
                if (!ok) return;
                const env = getLiveEnvData();
                const grp = env.settings.bindingGroups.find(g => g.id === actionEl.dataset.groupId);
                if (grp) {
                    state.activeTab = 'preset-lorebook';
                    loadGroupIntoComposer(grp, `正在编辑当前预设「${env.currentPreset}」所属的绑定关系`);
                    renderAll();
                }
                break;
            }

            case 'pick-current-preset': {
                const env = getLiveEnvData();
                if (!env.currentPreset) return;
                handlePrimaryPresetPick(env.currentPreset, env);
                renderAll();
                break;
            }

            case 'pick-group-color': {
                const pickedColor = actionEl.dataset.color || '';
                // Clicking already-selected color toggles it off for convenience
                state.groupColor = (pickedColor && state.groupColor === pickedColor) ? '' : pickedColor;
                renderAll();
                break;
            }

            case 'show-extra-preset-picker': {
                state.showExtraPresetPicker = true;
                renderAll();
                break;
            }

            case 'hide-extra-preset-picker': {
                state.showExtraPresetPicker = false;
                renderAll();
                break;
            }

            case 'remove-preset-chip': {
                const target = actionEl.dataset.preset;
                state.selectedPresets = state.selectedPresets.filter(p => p !== target);
                if (state.selectedPresets.length <= 1) state.showExtraPresetPicker = false;
                renderAll();
                break;
            }

            case 'fill-active-books': {
                const env = getLiveEnvData();
                state.selectedLorebooks = uniqueStrings([...state.selectedLorebooks, ...env.activeLorebooks]);
                renderAll();
                break;
            }

            case 'clear-selected-books': {
                state.selectedLorebooks = [];
                renderAll();
                break;
            }

            case 'clear-book-search': {
                state.lorebookSearch = '';
                renderAll();
                break;
            }

            case 'remove-book-chip': {
                const book = actionEl.dataset.book;
                state.selectedLorebooks = state.selectedLorebooks.filter(b => b !== book);
                renderAll();
                break;
            }

            case 'reset-pl-composer':
            case 'cancel-pl-edit': {
                resetPresetComposer();
                renderAll();
                break;
            }

            case 'save-pl-binding': {
                performSavePresetBinding();
                break;
            }

            case 'edit-group': {
                const grpId = actionEl.dataset.groupId;
                if (state.editingGroupId !== grpId) {
                    const ok = await confirmOrResolveDirty();
                    if (!ok) return;
                }
                const env = getLiveEnvData();
                const grp = env.settings.bindingGroups.find(g => g.id === grpId);
                if (grp) {
                    loadGroupIntoComposer(grp, '');
                    renderAll();
                    backdrop.querySelector('#lk-body')?.scrollTo({ top: 0, behavior: 'smooth' });
                }
                break;
            }

            case 'apply-group-now': {
                const env = getLiveEnvData();
                const grp = env.settings.bindingGroups.find(g => g.id === actionEl.dataset.groupId);
                if (!grp) return;

                const targetPreset = grp.presets.includes(env.currentPreset)
                    ? env.currentPreset
                    : grp.presets.find(p => env.allPresets.includes(p));

                if (targetPreset && env.pm && env.currentPreset !== targetPreset) {
                    const val = env.pm.findPreset(targetPreset);
                    if (val !== undefined && val !== null) {
                        env.pm.selectPreset(val);
                        renderAll();
                        return;
                    }
                }

                const titleLabel = grp.name ? `「${grp.name}」` : '该绑定组';
                syncActivePresetImmediately({ showToast: true, customToast: `已启用${titleLabel}中的 ${grp.lorebooks.length} 本世界书` });
                renderAll();
                break;
            }

            case 'delete-group': {
                const grpId = actionEl.dataset.groupId;
                const env = getLiveEnvData();
                const grp = env.settings.bindingGroups.find(g => g.id === grpId);
                if (!grp) return;

                const isCurrentInGroup = env.currentPreset && grp.presets.includes(env.currentPreset);
                const label = grp.name ? `${grp.name}（${grp.presets.join('、')}）` : grp.presets.join('、');
                const { choice, checked } = await openSubDialog({
                    title: '删除世界书绑定',
                    bodyHtml: `<p class="lk-sub-text">确定要移除 <b>「${esc(label)}」</b> 与 ${grp.lorebooks.length} 本世界书的绑定关系吗？</p>`,
                    checkboxLabel: isCurrentInGroup ? `同步撤下该组自动启用且当前不再需要的世界书` : '',
                    checkboxDefault: false,
                    buttons: [
                        { key: 'cancel', label: '取消', variant: 'ghost' },
                        { key: 'delete', label: '确认删除', variant: 'danger', icon: 'fa-solid fa-trash-can' },
                    ],
                });

                if (choice !== 'delete') return;

                deleteBindingGroup(grpId);
                if (state.editingGroupId === grpId) {
                    resetPresetComposer();
                }

                if (isCurrentInGroup && checked) {
                    syncActivePresetImmediately();
                    toastr.info(`已删除「${label}」的绑定并同步全局世界书`);
                } else {
                    toastr.info(`已删除「${label}」的绑定关系`);
                }

                syncExtensionDrawerSummary();
                renderAll();
                break;
            }

            case 'save-role':
            case 'clear-role': {
                const rolePreset = backdrop.querySelector('#lk-role-preset')?.value;
                const settings = loadSettings();
                if (actionEl.dataset.action === 'clear-role') delete settings.characterPresetBindings[editingAvatar];
                else if (rolePreset) settings.characterPresetBindings[editingAvatar] = { apiId: getActivePresetManager().apiId, preset: rolePreset };
                else { toastr.warning('请先选择角色预设'); return; }
                saveSettings(settings);
                await applyCurrentChatBinding();
                renderAll();
                break;
            }
            case 'save-chat-binding':
                await saveChatDraft(getDraftToSave());
                break;
            case 'clear-chat-binding':
                await saveChatDraft({});
                break;

            // Tab 3 actions
            case 'run-update-scan': {
                const env = getLiveEnvData();
                state.scanResults = scanAllUnboundPresetUpdates(
                    env.allPresets,
                    env.settings.bindingGroups,
                    env.settings.ignoredUpdatePresets,
                );
                renderAll();
                break;
            }

            case 'bind-scanned-one': {
                const preset = actionEl.dataset.preset;
                const groupId = actionEl.dataset.groupId;
                const env = getLiveEnvData();
                const res = attachPresetToGroup(groupId, preset);
                if (res.updated) {
                    if (env.currentPreset === preset && res.group) {
                        syncActivePresetImmediately();
                    }
                    toastr.success(`已将新版预设「${preset}」并入原世界书绑定组`);
                }
                const fresh = getLiveEnvData();
                state.scanResults = scanAllUnboundPresetUpdates(
                    fresh.allPresets,
                    fresh.settings.bindingGroups,
                    fresh.settings.ignoredUpdatePresets,
                );
                syncExtensionDrawerSummary();
                renderAll();
                break;
            }

            case 'bind-all-scanned': {
                const env = getLiveEnvData();
                const list = Array.isArray(state.scanResults) ? [...state.scanResults] : [];
                let count = 0;
                for (const item of list) {
                    const res = attachPresetToGroup(item.group.id, item.candidatePreset);
                    if (res.updated) {
                        count++;
                        if (env.currentPreset === item.candidatePreset && res.group) {
                            syncActivePresetImmediately();
                        }
                    }
                }
                state.scanResults = [];
                toastr.success(`已一键将 ${count} 个新版预设并入对应的世界书绑定组`);
                syncExtensionDrawerSummary();
                renderAll();
                break;
            }

            case 'ignore-scanned-one': {
                const preset = actionEl.dataset.preset;
                const s = loadSettings();
                if (preset && !s.ignoredUpdatePresets.includes(preset)) {
                    s.ignoredUpdatePresets.push(preset);
                    saveSettings(s);
                }
                if (Array.isArray(state.scanResults)) {
                    state.scanResults = state.scanResults.filter(x => x.candidatePreset !== preset);
                }
                renderAll();
                break;
            }

            case 'remove-ignored-one': {
                const preset = actionEl.dataset.preset;
                const s = loadSettings();
                s.ignoredUpdatePresets = s.ignoredUpdatePresets.filter(p => p !== preset);
                saveSettings(s);
                renderAll();
                break;
            }

            case 'clear-all-ignored': {
                const s = loadSettings();
                s.ignoredUpdatePresets = [];
                saveSettings(s);
                toastr.info('已恢复全部预设的更新识别提醒');
                renderAll();
                break;
            }
        }
    });

    function handlePrimaryPresetPick(picked, env) {
        if (!picked) {
            state.selectedPresets = state.selectedPresets.slice(1);
            return;
        }
        const existingGrp = findGroupByPreset(env.settings, picked);
        if (!state.editingGroupId && existingGrp && state.selectedLorebooks.length === 0 && state.selectedPresets.length <= 1) {
            loadGroupIntoComposer(existingGrp, `预设「${picked}」已有绑定关系，已自动载入现有配置供你修改。`);
            return;
        }
        if (state.selectedPresets.length <= 1) {
            state.selectedPresets = [picked];
        } else {
            state.selectedPresets = uniqueStrings([picked, ...state.selectedPresets.slice(1)]);
        }
    }


    backdrop.addEventListener('change', (e) => {
        const t = e.target;

        if (t.id === 'lk-main-preset-select') {
            const env = getLiveEnvData();
            handlePrimaryPresetPick(t.value, env);
            renderAll();
            return;
        }

        if (t.id === 'lk-extra-preset-select') {
            if (t.value) {
                state.selectedPresets = uniqueStrings([...state.selectedPresets, t.value]);
                renderAll();
            }
            return;
        }

        if (t.classList.contains('lk-book-checkbox')) {
            const book = t.value;
            if (t.checked) {
                state.selectedLorebooks = uniqueStrings([...state.selectedLorebooks, book]);
            } else {
                state.selectedLorebooks = state.selectedLorebooks.filter(b => b !== book);
            }
            const gridEl = backdrop.querySelector('#lk-book-grid');
            const prevScroll = gridEl ? gridEl.scrollTop : 0;
            renderAll();
            const nextGridEl = backdrop.querySelector('#lk-book-grid');
            if (nextGridEl) nextGridEl.scrollTop = prevScroll;
            return;
        }


        if (t.id === 'lk-role-avatar') {
            editingAvatar = t.value;
            renderAll();
            return;
        }
        if (t.id === 'lk-chat-mode') {
            draft.mode = t.value;
            draft.preset = t.value === 'preset' ? getCurrentPresetName() : '';
            draft.apiId = draft.preset ? getActivePresetManager()?.apiId : '';
            draft.prompts = {};
            renderAll();
            return;
        }
        if (t.id === 'lk-chat-preset') {
            draft.preset = t.value;
            draft.apiId = t.value ? getActivePresetManager()?.apiId || '' : '';
            draft.prompts = {};
            renderAll();
            return;
        }
        if (t.dataset.chatPrompt) {
            const apiId = getActivePresetManager()?.apiId;
            const target = resolvePreset(draft, apiId);
            if (draft.apiId !== apiId || draft.preset !== target) draft.prompts = {};
            draft.apiId = apiId;
            draft.preset = target;
            if (t.value) draft.prompts = { ...draft.prompts, [t.dataset.chatPrompt]: t.value === 'on' };
            else delete draft.prompts[t.dataset.chatPrompt];
            return;
        }
        if (t.dataset.chatBook) {
            draft.lorebooks = t.checked ? uniqueStrings([...draft.lorebooks, t.dataset.chatBook])
                : draft.lorebooks.filter(book => book !== t.dataset.chatBook);
            return;
        }
        if (t.classList.contains('lk-opt-checkbox') && t.dataset.opt) {
            const optKey = t.dataset.opt;
            const s = loadSettings();
            s.options[optKey] = Boolean(t.checked);
            saveSettings(s);
            syncExtensionDrawerSummary();
            renderAll();
        }
    });

    // Live inputs (IME-safe: never destroys the active input element while typing!)
    backdrop.addEventListener('input', (e) => {
        const t = e.target;
        if (t.id === 'lk-group-name-input') {
            state.groupName = t.value;
            refreshPlFooterStateOnly();
            return;
        }
        if (t.id === 'lk-book-search') {
            state.lorebookSearch = t.value;
            refreshBookGridOnly();
            return;
        }
        if (t.id === 'lk-rule-search') {
            state.ruleSearch = t.value;
            const pos = t.selectionStart;
            renderBody(getLiveEnvData());
            const nextInput = backdrop.querySelector('#lk-rule-search');
            if (nextInput) {
                nextInput.focus();
                if (typeof pos === 'number') nextInput.setSelectionRange(pos, pos);
            }
            return;
        }
    });

    document.addEventListener('keydown', onKeyDown);
    document.body.appendChild(backdrop);
    unbindVp = bindViewportPin(backdrop);
    renderAll();

    setOnStateChangedCallback(() => {
        if (backdrop.isConnected && (!isAnyDirty() || draftChat?.key !== currentChat()?.key)) {
            renderAll();
        } else if (backdrop.isConnected) {
            renderStatusBar(getLiveEnvData());
        }
    });

    activeModal = {
        focusPanel: () => backdrop.querySelector('.lk-modal')?.focus?.(),
    };
}

export function syncExtensionDrawerSummary() {
    const s = loadSettings();
    const summaryEl = document.getElementById('lk-drawer-summary');
    if (summaryEl) {
        const gCount = s.bindingGroups.length;
        summaryEl.textContent = `已保存 ${gCount} 组预设世界书绑定`;
    }
    const autoChk = document.getElementById('lk-drawer-auto-update');
    if (autoChk) {
        autoChk.checked = Boolean(s.options.autoBindPresetUpdate);
    }
}

export function mountExtensionEntries() {
    const extMenu = document.getElementById('extensionsMenu');
    if (extMenu && !document.getElementById('preset-binder-menu-item')) {
        const container = document.createElement('div');
        container.className = 'extension_container';
        const item = document.createElement('div');
        item.id = 'preset-binder-menu-item';
        item.tabIndex = 0;
        item.setAttribute('role', 'button');
        item.innerHTML = `
            <div aria-hidden="true" class="fa-solid fa-link extensionsMenuExtensionButton"></div>
            <span>${esc(EXTENSION_DISPLAY_NAME)}</span>
        `;
        item.addEventListener('click', () => showSettingsPanel('preset-lorebook'));
        item.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            item.click();
        });
        container.appendChild(item);
        extMenu.appendChild(container);
    }

    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (host && !document.getElementById('lk-extension-drawer')) {
        const s = loadSettings();
        const wrapper = document.createElement('div');
        wrapper.id = 'lk-extension-drawer';
        wrapper.className = 'extension_container';
        wrapper.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-link" style="margin-right:6px;"></i>${esc(EXTENSION_DISPLAY_NAME)}</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content" style="display: none;">
                    <div class="lk-drawer-inner">
                        <div id="lk-drawer-summary" class="lk-drawer-summary"></div>
                        <label class="checkbox_label">
                            <input type="checkbox" id="lk-drawer-auto-update" ${s.options.autoBindPresetUpdate ? 'checked' : ''} />
                            <span>自动将新版预设绑定到旧关系（近似名称识别）</span>
                        </label>
                        <div class="lk-drawer-actions">
                            <button type="button" id="lk-drawer-open-btn" class="menu_button lk-drawer-btn">
                                <i class="fa-solid fa-sliders"></i>
                                <span>打开绑定管理面板</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        wrapper.querySelector('#lk-drawer-auto-update')?.addEventListener('change', (e) => {
            const cur = loadSettings();
            cur.options.autoBindPresetUpdate = Boolean(e.target.checked);
            saveSettings(cur);
            toastr.info(cur.options.autoBindPresetUpdate ? '已开启新版预设自动继承绑定' : '已关闭新版预设自动继承绑定');
        });

        wrapper.querySelector('#lk-drawer-open-btn')?.addEventListener('click', () => {
            showSettingsPanel('preset-lorebook');
        });

        host.appendChild(wrapper);
        syncExtensionDrawerSummary();
    }
}
