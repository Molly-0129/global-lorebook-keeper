// Modernized Binder Management Panel with intuitive 3-step workflow & unsaved-changes guard

import {
    applyGlobalLorebookDiff,
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
    loadSettings,
    saveSettings,
    uniqueStrings,
    upsertBindingGroup,
} from './storage.js';

let activeModal = null;

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

    // Panel UI state
    const state = {
        activeTab: initialTab,
        // Tab 1: Preset -> Lorebook Composer
        editingGroupId: null,
        selectedPresets: [],
        selectedLorebooks: [],
        showExtraPresetPicker: false,
        lorebookSearch: '',
        ruleSearch: '',
        plBaseline: JSON.stringify({ presets: [], lorebooks: [] }),
        plNotice: '',
        lastSavedGroupId: null,

        // Tab 2: Character -> Preset Composer
        editingCharAvatar: null,
        selectedCharAvatar: '',
        selectedCharPreset: '',
        charSearch: '',
        cpBaseline: JSON.stringify({ avatar: '', preset: '' }),
        cpNotice: '',
        lastSavedCharAvatar: null,

        // Tab 3: Scan results
        scanResults: null,
    };

    const isPresetComposerDirty = () => {
        const cur = JSON.stringify({
            presets: uniqueStrings(state.selectedPresets),
            lorebooks: uniqueStrings(state.selectedLorebooks),
        });
        return cur !== state.plBaseline;
    };

    const isCharComposerDirty = () => {
        const cur = JSON.stringify({
            avatar: state.selectedCharAvatar || '',
            preset: state.selectedCharPreset || '',
        });
        return cur !== state.cpBaseline;
    };

    const isAnyDirty = () => isPresetComposerDirty() || isCharComposerDirty();

    const resetPresetComposer = (notice = '') => {
        state.editingGroupId = null;
        state.selectedPresets = [];
        state.selectedLorebooks = [];
        state.showExtraPresetPicker = false;
        state.plBaseline = JSON.stringify({ presets: [], lorebooks: [] });
        state.plNotice = notice;
    };

    const loadGroupIntoComposer = (grp, notice = '') => {
        state.editingGroupId = grp.id;
        state.selectedPresets = [...grp.presets];
        state.selectedLorebooks = [...grp.lorebooks];
        state.showExtraPresetPicker = grp.presets.length > 1;
        state.plBaseline = JSON.stringify({
            presets: uniqueStrings(grp.presets),
            lorebooks: uniqueStrings(grp.lorebooks),
        });
        state.plNotice = notice;
    };

    const resetCharComposer = (notice = '') => {
        state.editingCharAvatar = null;
        state.selectedCharAvatar = '';
        state.selectedCharPreset = '';
        state.cpBaseline = JSON.stringify({ avatar: '', preset: '' });
        state.cpNotice = notice;
    };

    const loadCharIntoComposer = (avatar, presetName, notice = '') => {
        state.editingCharAvatar = avatar;
        state.selectedCharAvatar = avatar;
        state.selectedCharPreset = presetName;
        state.cpBaseline = JSON.stringify({ avatar: avatar || '', preset: presetName || '' });
        state.cpNotice = notice;
    };

    // Build DOM
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
                        <div class="lk-subtitle">管理角色、预设与全局世界书的自动联动关系</div>
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
        const allCharacters = Array.isArray(ctx?.characters) ? ctx.characters.filter(c => c?.avatar) : [];
        const settings = loadSettings();
        return {
            pm,
            allPresets,
            allLorebooks,
            activeLorebooks,
            currentPreset,
            currentChar,
            allCharacters,
            settings,
        };
    };

    // Save handlers (return boolean: true if saved successfully)
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
            presets,
            lorebooks,
        });

        state.lastSavedGroupId = group.id;
        resetPresetComposer('');

        // Immediately sync global lorebooks if active preset was part of previous or new group
        const wasActiveInvolved = activePreset && (presets.includes(activePreset) || prevActiveBooks.length > 0);
        let syncMsg = '';
        if (wasActiveInvolved) {
            const syncRes = syncActivePresetImmediately({ previousBooksForActivePreset: prevActiveBooks });
            if (syncRes.isActivePreset && presets.includes(activePreset)) {
                syncMsg = `，当前全局世界书已即时同步（启用 ${syncRes.activatedValid.length} 本）`;
            }
        }

        const movedMsg = movedPresets.length > 0
            ? `（已将「${movedPresets.join('、')}」从旧规则并入此组）`
            : '';

        const label = presets.length === 1 ? `「${presets[0]}」` : `「${presets[0]}」等 ${presets.length} 个预设`;
        toastr.success(`已保存 ${label} 的 ${lorebooks.length} 本世界书绑定${movedMsg}${syncMsg}`);

        syncExtensionDrawerSummary();
        renderAll();
        return true;
    };

    const performSaveCharBinding = () => {
        const avatar = String(state.selectedCharAvatar || '').trim();
        const preset = String(state.selectedCharPreset || '').trim();

        if (!avatar) {
            toastr.warning('请先选择要绑定的角色。');
            return false;
        }
        if (!preset) {
            toastr.warning('请选择该角色对应的预设。');
            return false;
        }

        const env = getLiveEnvData();
        const settings = env.settings;
        if (state.editingCharAvatar && state.editingCharAvatar !== avatar) {
            delete settings.characterPresetBindings[state.editingCharAvatar];
        }
        settings.characterPresetBindings[avatar] = preset;
        saveSettings(settings);

        state.lastSavedCharAvatar = avatar;
        resetCharComposer('');

        const charObj = env.allCharacters.find(c => c.avatar === avatar);
        const charName = charObj?.name || avatar;

        // If saved character is the currently active character, switch preset right away!
        let switchedMsg = '';
        if (env.currentChar?.avatar === avatar && env.pm) {
            const val = env.pm.findPreset(preset);
            if (val !== undefined && val !== null && env.pm.getSelectedPresetName() !== preset) {
                env.pm.selectPreset(val);
                switchedMsg = '，并已为当前聊天切换至此预设';
            }
        }

        toastr.success(`已为角色「${charName}」绑定预设「${preset}」${switchedMsg}`);
        syncExtensionDrawerSummary();
        renderAll();
        return true;
    };

    /**
     * Guards actions that would discard unsaved composer changes (closing modal, switching tabs, loading another item).
     * @returns {Promise<boolean>} true if caller may proceed
     */
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
        if (isCharComposerDirty()) {
            const action = await promptUnsavedChanges(contextDesc || '「角色 ↔ 预设」编辑区有未保存的绑定配置');
            if (action === 'cancel') return false;
            if (action === 'save') {
                return performSaveCharBinding();
            }
            resetCharComposer();
            return true;
        }
        return true;
    };

    // Rendering pieces
    const renderStatusBar = (env) => {
        const bar = backdrop.querySelector('#lk-status-bar');
        if (!bar) return;

        const activeGroup = env.currentPreset ? findGroupByPreset(env.settings, env.currentPreset) : null;
        const boundCount = activeGroup ? activeGroup.lorebooks.length : 0;

        const presetStatusBadge = !env.currentPreset
            ? '<span class="lk-badge is-muted">无预设</span>'
            : activeGroup
                ? `<span class="lk-badge is-ok"><i class="fa-solid fa-shield-halved"></i>已绑定 ${boundCount} 本</span>`
                : '<span class="lk-badge is-muted">未绑定</span>';

        let quickActionHtml = '';
        if (env.currentPreset && !activeGroup) {
            quickActionHtml = `
                <button type="button" class="lk-btn lk-btn-xs lk-btn-accent-soft" data-action="quick-fill-current" title="将当前预设与当前全局已启用的世界书一键填入下方工作台">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>快速绑定当前状态</span>
                </button>
            `;
        } else if (env.currentPreset && activeGroup) {
            quickActionHtml = `
                <button type="button" class="lk-btn lk-btn-xs lk-btn-ghost" data-action="quick-edit-current" data-group-id="${esc(activeGroup.id)}">
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
        const cpCount = Object.keys(env.settings.characterPresetBindings).length;
        const autoOn = Boolean(env.settings.options.autoBindPresetUpdate);

        tabsEl.innerHTML = `
            <button type="button" role="tab" class="lk-tab ${state.activeTab === 'preset-lorebook' ? 'is-active' : ''}" data-tab="preset-lorebook">
                <i class="fa-solid fa-book-bookmark"></i>
                <span>预设 ↔ 世界书</span>
                <span class="lk-tab-count">${plCount}</span>
            </button>
            <button type="button" role="tab" class="lk-tab ${state.activeTab === 'char-preset' ? 'is-active' : ''}" data-tab="char-preset">
                <i class="fa-solid fa-user-Astronaut fa-user-tag"></i>
                <span>角色 ↔ 预设</span>
                <span class="lk-tab-count">${cpCount}</span>
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

        // Include any missing/deleted presets or lorebooks currently in selection so user can see & clean them
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
                    ? ` · 已绑 ${existingGrp.lorebooks.length} 本`
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
                        <select class="lk-select lk-select-sm" id="lk-extra-preset-select">
                            <option value="">-- 选择另一个共用同组世界书的预设（如新版/分支） --</option>
                            ${availableExtraPresets.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}
                        </select>
                        <button type="button" class="lk-btn lk-btn-xs lk-btn-ghost" data-action="hide-extra-preset-picker">收起</button>
                    </div>
                ` : `
                    <button type="button" class="lk-link-btn" data-action="show-extra-preset-picker">
                        <i class="fa-solid fa-plus"></i> 添加共用同一组世界书的其他预设（如多版本共存）
                    </button>
                `}
            </div>
        ` : '';

        // Filter lorebooks for checklist
        const kw = state.lorebookSearch.trim().toLowerCase();
        const combinedBooks = uniqueStrings([...state.selectedLorebooks, ...env.allLorebooks]);
        // Preserve natural `allLorebooks` order, putting missing-but-selected books at top so they are visible
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
                        <label class="lk-book-item ${checked ? 'is-checked' : ''} ${exists ? '' : 'is-missing'}" title="${esc(book)}">
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
            ? env.settings.bindingGroups.filter(g =>
                g.presets.some(p => p.toLowerCase().includes(rkw))
                || g.lorebooks.some(b => b.toLowerCase().includes(rkw)))
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
                        <div class="lk-rule-card ${isBeingEdited ? 'is-editing' : ''} ${isJustSaved ? 'is-flash' : ''} ${isCurrentActive ? 'is-active-group' : ''}" data-group-id="${esc(grp.id)}">
                            <div class="lk-rule-main">
                                <div class="lk-rule-presets">${presetBadges}</div>
                                <div class="lk-rule-arrow"><i class="fa-solid fa-arrow-right-long"></i></div>
                                <div class="lk-rule-books">${bookPills}</div>
                            </div>
                            <div class="lk-rule-actions">
                                <button type="button" class="lk-btn lk-btn-xs lk-btn-ghost" data-action="apply-group-now" data-group-id="${esc(grp.id)}" title="立即切换到此预设并启用绑定的世界书">
                                    <i class="fa-solid fa-bolt"></i><span>套用</span>
                                </button>
                                <button type="button" class="lk-btn lk-btn-xs lk-btn-secondary" data-action="edit-group" data-group-id="${esc(grp.id)}" title="加载到上方编辑区修改">
                                    <i class="fa-solid fa-pen"></i><span>编辑</span>
                                </button>
                                <button type="button" class="lk-btn lk-btn-xs lk-btn-danger-ghost" data-action="delete-group" data-group-id="${esc(grp.id)}" title="删除此绑定关系">
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
                            <span>${isEditing ? '修改已有世界书绑定组' : '按步骤配置预设与世界书联动'}</span>
                        </div>
                        ${isEditing ? `
                            <button type="button" class="lk-btn lk-btn-xs lk-btn-ghost" data-action="cancel-pl-edit">
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
                        <select id="lk-main-preset-select" class="lk-select">
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
                            <input type="search" id="lk-book-search" class="lk-search-input" placeholder="搜索世界书名称..." value="${esc(state.lorebookSearch)}" />
                            ${state.lorebookSearch ? `<button type="button" class="lk-search-clear" data-action="clear-book-search" title="清除搜索">&times;</button>` : ''}
                        </div>

                        ${selectedBookChipsHtml}

                        <div class="lk-book-grid" id="lk-book-grid">
                            ${checklistHtml}
                        </div>
                    </div>

                    <div class="lk-composer-footer">
                        <div class="lk-dirty-indicator">
                            ${dirty ? '<span class="lk-dirty-dot"></span><span>有未保存的修改，点击右侧按钮保存生效</span>' : '<span class="lk-muted-hint">保存后若该预设正在使用，将立即同步全局世界书</span>'}
                        </div>
                        <div class="lk-composer-btns">
                            ${(dirty || isEditing) ? `
                                <button type="button" class="lk-btn lk-btn-secondary" data-action="reset-pl-composer">
                                    <span>${isEditing ? '取消修改' : '重置'}</span>
                                </button>
                            ` : ''}
                            <button type="button" class="lk-btn lk-btn-primary ${state.selectedPresets.length && state.selectedLorebooks.length ? '' : 'is-incomplete'}" data-action="save-pl-binding">
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
                                <input type="search" id="lk-rule-search" class="lk-search-input" placeholder="筛选预设或世界书..." value="${esc(state.ruleSearch)}" />
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

    const renderCharPresetTab = (env) => {
        const isEditing = Boolean(state.editingCharAvatar);
        const dirty = isCharComposerDirty();
        const charMap = new Map(env.allCharacters.map(c => [c.avatar, c]));
        const presetSet = new Set(env.allPresets);

        const charOptions = [
            `<option value="">-- 请选择角色 --</option>`,
            ...(state.selectedCharAvatar && !charMap.has(state.selectedCharAvatar)
                ? [`<option value="${esc(state.selectedCharAvatar)}" selected>${esc(state.selectedCharAvatar)} (角色未找到)</option>`]
                : []),
            ...env.allCharacters.map((c) => {
                const bound = env.settings.characterPresetBindings[c.avatar];
                const suffix = bound && c.avatar !== state.editingCharAvatar ? ` · 已绑: ${bound}` : '';
                return `<option value="${esc(c.avatar)}" ${c.avatar === state.selectedCharAvatar ? 'selected' : ''}>${esc(c.name)}${esc(suffix)}</option>`;
            }),
        ].join('');

        const presetOptions = [
            `<option value="">-- 请选择要绑定的预设 --</option>`,
            ...(state.selectedCharPreset && !presetSet.has(state.selectedCharPreset)
                ? [`<option value="${esc(state.selectedCharPreset)}" selected>${esc(state.selectedCharPreset)} (预设未找到)</option>`]
                : []),
            ...env.allPresets.map(p => `<option value="${esc(p)}" ${p === state.selectedCharPreset ? 'selected' : ''}>${esc(p)}</option>`),
        ].join('');

        // Linkage preview for selected preset
        let linkageHintHtml = '';
        if (state.selectedCharPreset) {
            const linkedBooks = getLorebooksForPreset(env.settings, state.selectedCharPreset);
            if (linkedBooks.length > 0) {
                linkageHintHtml = `
                    <div class="lk-linkage-preview is-linked">
                        <i class="fa-solid fa-link"></i>
                        <span>联动预览：打开该角色聊天时，将自动切换到预设<b>「${esc(state.selectedCharPreset)}」</b>并联动启用 <b>${linkedBooks.length} 本世界书</b>（${esc(linkedBooks.slice(0, 4).join('、'))}${linkedBooks.length > 4 ? '…' : ''}）。</span>
                    </div>
                `;
            } else {
                linkageHintHtml = `
                    <div class="lk-linkage-preview">
                        <i class="fa-regular fa-lightbulb"></i>
                        <span>提示：预设「${esc(state.selectedCharPreset)}」暂未配置世界书绑定，进入角色聊天时仅自动切换预设。</span>
                    </div>
                `;
            }
        }

        const entries = Object.entries(env.settings.characterPresetBindings);
        const ckw = state.charSearch.trim().toLowerCase();
        const filteredEntries = ckw
            ? entries.filter(([avatar, preset]) => {
                const cName = charMap.get(avatar)?.name || avatar;
                return cName.toLowerCase().includes(ckw) || preset.toLowerCase().includes(ckw);
            })
            : entries;

        const charCardsHtml = entries.length === 0
            ? `
                <div class="lk-empty-card">
                    <i class="fa-solid fa-user-tag lk-empty-icon"></i>
                    <div class="lk-empty-title">还没有角色与预设绑定</div>
                    <div class="lk-empty-desc">为特定角色绑定专属预设后，每次打开该角色的聊天窗口，会自动切换到对应预设并触发世界书联动。</div>
                </div>
            `
            : filteredEntries.length === 0
                ? `<div class="lk-empty-inline">没有匹配「${esc(state.charSearch)}」的角色绑定</div>`
                : filteredEntries.map(([avatar, presetName]) => {
                    const charObj = charMap.get(avatar);
                    const charName = charObj?.name || avatar;
                    const charExists = Boolean(charObj);
                    const presetExists = presetSet.has(presetName);
                    const linkedBooks = getLorebooksForPreset(env.settings, presetName);
                    const isCurrentChar = env.currentChar?.avatar === avatar;
                    const isBeingEdited = state.editingCharAvatar === avatar;
                    const isJustSaved = state.lastSavedCharAvatar === avatar;

                    return `
                        <div class="lk-rule-card ${isBeingEdited ? 'is-editing' : ''} ${isJustSaved ? 'is-flash' : ''} ${isCurrentChar ? 'is-active-group' : ''}">
                            <div class="lk-rule-main">
                                <div class="lk-rule-presets">
                                    <span class="lk-rule-preset ${isCurrentChar ? 'is-current' : ''} ${charExists ? '' : 'is-missing'}">
                                        <i class="fa-solid fa-user"></i>
                                        <span>${esc(charName)}</span>
                                        ${isCurrentChar ? '<em>当前</em>' : !charExists ? '<em>角色未找到</em>' : ''}
                                    </span>
                                </div>
                                <div class="lk-rule-arrow"><i class="fa-solid fa-arrow-right-long"></i></div>
                                <div class="lk-rule-books">
                                    <span class="lk-rule-book ${presetExists ? 'is-preset-pill' : 'is-missing'}">
                                        <i class="fa-solid fa-sliders"></i> ${esc(presetName)}${presetExists ? '' : ' (预设未找到)'}
                                    </span>
                                    ${linkedBooks.length > 0 ? `<span class="lk-mini-tag is-live" title="${esc(linkedBooks.join('、'))}">联动 ${linkedBooks.length} 本世界书</span>` : ''}
                                </div>
                            </div>
                            <div class="lk-rule-actions">
                                <button type="button" class="lk-btn lk-btn-xs lk-btn-secondary" data-action="edit-char-binding" data-avatar="${esc(avatar)}">
                                    <i class="fa-solid fa-pen"></i><span>编辑</span>
                                </button>
                                <button type="button" class="lk-btn lk-btn-xs lk-btn-danger-ghost" data-action="delete-char-binding" data-avatar="${esc(avatar)}" title="删除此角色绑定">
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
                            <span>设置进入角色聊天时自动切换的预设</span>
                        </div>
                        ${isEditing ? `
                            <button type="button" class="lk-btn lk-btn-xs lk-btn-ghost" data-action="cancel-cp-edit">
                                <i class="fa-solid fa-rotate-left"></i><span>退出编辑</span>
                            </button>
                        ` : ''}
                    </div>

                    ${state.cpNotice ? `<div class="lk-inline-banner"><i class="fa-solid fa-circle-info"></i><span>${esc(state.cpNotice)}</span></div>` : ''}

                    <div class="lk-two-col">
                        <div class="lk-step">
                            <div class="lk-step-head">
                                <label class="lk-step-label" for="lk-char-select"><span class="lk-step-num">1</span>选择角色</label>
                                ${env.currentChar ? `
                                    <button type="button" class="lk-link-btn" data-action="pick-current-char">填入当前角色「${esc(env.currentChar.name)}」</button>
                                ` : ''}
                            </div>
                            <select id="lk-char-select" class="lk-select">${charOptions}</select>
                        </div>

                        <div class="lk-step">
                            <div class="lk-step-head">
                                <label class="lk-step-label" for="lk-char-preset-select"><span class="lk-step-num">2</span>选择绑定预设</label>
                                ${env.currentPreset ? `
                                    <button type="button" class="lk-link-btn" data-action="pick-current-preset-for-char">填入当前预设</button>
                                ` : ''}
                            </div>
                            <select id="lk-char-preset-select" class="lk-select">${presetOptions}</select>
                        </div>
                    </div>

                    ${linkageHintHtml}

                    <div class="lk-composer-footer">
                        <div class="lk-dirty-indicator">
                            ${dirty ? '<span class="lk-dirty-dot"></span><span>有未保存的角色绑定修改</span>' : '<span class="lk-muted-hint">切换聊天时将自动为你套用角色绑定的预设</span>'}
                        </div>
                        <div class="lk-composer-btns">
                            ${(dirty || isEditing) ? `
                                <button type="button" class="lk-btn lk-btn-secondary" data-action="reset-cp-composer">
                                    <span>${isEditing ? '取消修改' : '重置'}</span>
                                </button>
                            ` : ''}
                            <button type="button" class="lk-btn lk-btn-primary ${state.selectedCharAvatar && state.selectedCharPreset ? '' : 'is-incomplete'}" data-action="save-cp-binding">
                                <i class="fa-solid fa-check"></i>
                                <span>${isEditing ? '保存修改' : '保存角色绑定'}</span>
                            </button>
                        </div>
                    </div>
                </div>

                <div class="lk-list-section">
                    <div class="lk-list-header">
                        <div class="lk-list-title">已绑定的角色 <span>(${entries.length})</span></div>
                        ${entries.length >= 4 ? `
                            <div class="lk-search-box lk-search-sm">
                                <i class="fa-solid fa-magnifying-glass"></i>
                                <input type="search" id="lk-char-search" class="lk-search-input" placeholder="搜索角色或预设..." value="${esc(state.charSearch)}" />
                            </div>
                        ` : ''}
                    </div>
                    <div class="lk-rule-list">
                        ${charCardsHtml}
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
                                <button type="button" class="lk-btn lk-btn-xs lk-btn-primary" data-action="bind-all-scanned">
                                    <i class="fa-solid fa-check-double"></i><span>全部一键继承</span>
                                </button>
                            ` : ''}
                        </div>
                        ${state.scanResults.map(item => `
                            <div class="lk-scan-row">
                                <div class="lk-scan-info">
                                    <b>${esc(item.candidatePreset)}</b>
                                    <span class="lk-muted-hint">匹配自「${esc(item.matchedPreset)}」· 共 ${item.group.lorebooks.length} 本世界书</span>
                                </div>
                                <div class="lk-scan-actions">
                                    <button type="button" class="lk-btn lk-btn-xs lk-btn-primary" data-action="bind-scanned-one" data-preset="${esc(item.candidatePreset)}" data-group-id="${esc(item.group.id)}">
                                        <span>并入绑定</span>
                                    </button>
                                    <button type="button" class="lk-btn lk-btn-xs lk-btn-ghost" data-action="ignore-scanned-one" data-preset="${esc(item.candidatePreset)}">
                                        <span>忽略</span>
                                    </button>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `;
            }
        }

        return `
            <div class="lk-section lk-settings-section">
                <div class="lk-settings-card">
                    <div class="lk-settings-group-title">预设更新识别与继承</div>

                    <label class="lk-switch-row">
                        <div class="lk-switch-text">
                            <div class="lk-switch-title">自动将新版预设绑定到旧关系</div>
                            <div class="lk-switch-desc">导入或切换到名称近似的新版预设（例如 <code>v1.1 → v1.2</code>、同名覆盖、带日期后缀）时，无需询问直接并入原世界书绑定组并保持世界书开启。默认关闭。</div>
                        </div>
                        <input type="checkbox" class="lk-toggle-input" data-opt="autoBindPresetUpdate" ${opts.autoBindPresetUpdate ? 'checked' : ''} />
                    </label>

                    <label class="lk-switch-row ${opts.autoBindPresetUpdate ? 'is-dimmed' : ''}">
                        <div class="lk-switch-text">
                            <div class="lk-switch-title">识别到疑似新版预设时弹窗询问</div>
                            <div class="lk-switch-desc">${opts.autoBindPresetUpdate ? '已开启上方自动绑定，新版预设将直接静默继承并弹出通知。' : '当自动绑定关闭时，若切换到与已绑定预设名称近似的新预设，弹窗提示你是否一键继承世界书，防止忘记绑定掉世界书。'}</div>
                        </div>
                        <input type="checkbox" class="lk-toggle-input" data-opt="promptOnPresetUpdate" ${opts.promptOnPresetUpdate !== false ? 'checked' : ''} ${opts.autoBindPresetUpdate ? 'disabled' : ''} />
                    </label>

                    <label class="lk-switch-row">
                        <div class="lk-switch-text">
                            <div class="lk-switch-title">继承新版预设时同步更新角色绑定</div>
                            <div class="lk-switch-desc">当新版预设并入旧绑定组时，默认将原本绑定在旧版本预设上的角色一并更新为新版预设。</div>
                        </div>
                        <input type="checkbox" class="lk-toggle-input" data-opt="syncCharPresetOnUpdate" ${opts.syncCharPresetOnUpdate ? 'checked' : ''} />
                    </label>
                </div>

                <div class="lk-settings-card">
                    <div class="lk-settings-group-title">通知与反馈</div>
                    <label class="lk-switch-row">
                        <div class="lk-switch-text">
                            <div class="lk-switch-title">切换预设或角色联动时显示右上角提醒</div>
                            <div class="lk-switch-desc">自动启用/卸载世界书或按角色切换预设时，弹出简短 Toast 状态提示（缺失世界书的警告始终保留）。</div>
                        </div>
                        <input type="checkbox" class="lk-toggle-input" data-opt="notifyOnSwitch" ${opts.notifyOnSwitch !== false ? 'checked' : ''} />
                    </label>
                </div>

                <div class="lk-settings-card">
                    <div class="lk-settings-group-title">手动扫描与忽略管理</div>
                    <div class="lk-tool-row">
                        <div class="lk-switch-text">
                            <div class="lk-switch-title">扫描当前未绑定的新版预设</div>
                            <div class="lk-switch-desc">立即检查当前 API 下所有预设，找出与现有绑定名称近似但尚未绑定的预设版本。</div>
                        </div>
                        <button type="button" class="lk-btn lk-btn-secondary" data-action="run-update-scan">
                            <i class="fa-solid fa-radar fa-magnifying-glass-chart"></i>
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
        } else if (state.activeTab === 'char-preset') {
            body.innerHTML = renderCharPresetTab(env);
        } else {
            body.innerHTML = renderSettingsTab(env);
        }
    };

    const renderAll = () => {
        const env = getLiveEnvData();
        renderStatusBar(env);
        renderTabs(env);
        renderBody(env);

        if (state.lastSavedGroupId || state.lastSavedCharAvatar) {
            setTimeout(() => {
                state.lastSavedGroupId = null;
                state.lastSavedCharAvatar = null;
            }, 900);
        }
    };

    // Selective re-render for search inputs so typing never loses IME composition or cursor position
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
                    <label class="lk-book-item ${checked ? 'is-checked' : ''} ${exists ? '' : 'is-missing'}" title="${esc(book)}">
                        <input type="checkbox" class="lk-book-checkbox" value="${esc(book)}" ${checked ? 'checked' : ''} />
                        <span class="lk-book-name">${esc(book)}</span>
                        ${!exists ? '<span class="lk-mini-tag is-warn">未找到</span>' : isGlobalActive ? '<span class="lk-mini-tag is-live">启用中</span>' : ''}
                    </label>
                `;
            }).join('');
        }
    };

    // Close modal safely with unsaved-changes check
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
            // Ignore if a sub-dialog is currently open above us
            if (document.querySelector('.lk-backdrop-sub')) return;
            e.preventDefault();
            e.stopPropagation();
            requestCloseModal();
        }
    };

    // Event delegation inside modal
    backdrop.addEventListener('click', async (e) => {
        e.stopPropagation();

        // Backdrop click or top-right X button
        if (e.target === backdrop || e.target.closest('.lk-main-close')) {
            await requestCloseModal();
            return;
        }

        // Tab switching
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

                // Find the first existing preset in this group (preferring currentPreset if already in it)
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

                // Already on preset or preset missing -> directly ensure its lorebooks are enabled
                applyGlobalLorebookDiff([], grp.lorebooks, {
                    presetLabel: targetPreset || grp.presets[0],
                    showToast: true,
                    customToast: `已启用绑定组中的 ${grp.lorebooks.length} 本世界书`,
                });
                renderAll();
                break;
            }

            case 'delete-group': {
                const grpId = actionEl.dataset.groupId;
                const env = getLiveEnvData();
                const grp = env.settings.bindingGroups.find(g => g.id === grpId);
                if (!grp) return;

                const isCurrentInGroup = env.currentPreset && grp.presets.includes(env.currentPreset);
                const label = grp.presets.join('、');
                const { choice, checked } = await openSubDialog({
                    title: '删除世界书绑定',
                    bodyHtml: `<p class="lk-sub-text">确定要移除预设 <b>「${esc(label)}」</b> 与 ${grp.lorebooks.length} 本世界书的绑定关系吗？</p>`,
                    checkboxLabel: isCurrentInGroup ? `同时在当前全局世界书中关闭这 ${grp.lorebooks.length} 本世界书` : '',
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
                    applyGlobalLorebookDiff(grp.lorebooks, [], {
                        presetLabel: env.currentPreset,
                        showToast: false,
                    });
                    toastr.info(`已删除「${label}」的绑定，并同步关闭对应世界书`);
                } else {
                    toastr.info(`已删除「${label}」的绑定关系`);
                }

                syncExtensionDrawerSummary();
                renderAll();
                break;
            }

            // Tab 2 actions
            case 'pick-current-char': {
                const env = getLiveEnvData();
                if (!env.currentChar) return;
                handleCharPick(env.currentChar.avatar, env);
                renderAll();
                break;
            }

            case 'pick-current-preset-for-char': {
                const env = getLiveEnvData();
                if (!env.currentPreset) return;
                state.selectedCharPreset = env.currentPreset;
                renderAll();
                break;
            }

            case 'reset-cp-composer':
            case 'cancel-cp-edit': {
                resetCharComposer();
                renderAll();
                break;
            }

            case 'save-cp-binding': {
                performSaveCharBinding();
                break;
            }

            case 'edit-char-binding': {
                const avatar = actionEl.dataset.avatar;
                if (state.editingCharAvatar !== avatar) {
                    const ok = await confirmOrResolveDirty();
                    if (!ok) return;
                }
                const env = getLiveEnvData();
                const preset = env.settings.characterPresetBindings[avatar];
                if (preset) {
                    loadCharIntoComposer(avatar, preset, '');
                    renderAll();
                    backdrop.querySelector('#lk-body')?.scrollTo({ top: 0, behavior: 'smooth' });
                }
                break;
            }

            case 'delete-char-binding': {
                const avatar = actionEl.dataset.avatar;
                const env = getLiveEnvData();
                const preset = env.settings.characterPresetBindings[avatar];
                if (!preset) return;
                const charName = env.allCharacters.find(c => c.avatar === avatar)?.name || avatar;

                const { choice } = await openSubDialog({
                    title: '移除角色预设绑定',
                    bodyHtml: `<p class="lk-sub-text">确定要移除角色 <b>「${esc(charName)}」</b> 与预设 <b>「${esc(preset)}」</b> 的自动切换关系吗？</p>`,
                    buttons: [
                        { key: 'cancel', label: '取消', variant: 'ghost' },
                        { key: 'delete', label: '确认移除', variant: 'danger', icon: 'fa-solid fa-trash-can' },
                    ],
                });
                if (choice !== 'delete') return;

                delete env.settings.characterPresetBindings[avatar];
                saveSettings(env.settings);
                if (state.editingCharAvatar === avatar) {
                    resetCharComposer();
                }
                toastr.info(`已移除角色「${charName}」的预设绑定`);
                syncExtensionDrawerSummary();
                renderAll();
                break;
            }

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
                const res = attachPresetToGroup(groupId, preset, {
                    replaceOldPresetInChars: Boolean(env.settings.options.syncCharPresetOnUpdate),
                });
                if (res.updated) {
                    if (env.currentPreset === preset && res.group) {
                        applyGlobalLorebookDiff([], res.group.lorebooks, { presetLabel: preset, showToast: false });
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
                    const res = attachPresetToGroup(item.group.id, item.candidatePreset, {
                        replaceOldPresetInChars: Boolean(env.settings.options.syncCharPresetOnUpdate),
                    });
                    if (res.updated) {
                        count++;
                        if (env.currentPreset === item.candidatePreset && res.group) {
                            applyGlobalLorebookDiff([], res.group.lorebooks, { presetLabel: item.candidatePreset, showToast: false });
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
        // If user is in New Binding mode and hasn't modified books yet, auto-load existing group for convenience!
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

    function handleCharPick(avatar, env) {
        if (!avatar) {
            state.selectedCharAvatar = '';
            return;
        }
        const existingPreset = env.settings.characterPresetBindings[avatar];
        if (!state.editingCharAvatar && existingPreset && !state.selectedCharPreset) {
            const cName = env.allCharacters.find(c => c.avatar === avatar)?.name || avatar;
            loadCharIntoComposer(avatar, existingPreset, `角色「${cName}」已绑定预设，已载入现有配置供你修改。`);
            return;
        }
        state.selectedCharAvatar = avatar;
    }

    // Change events (selects, checkboxes, toggles)
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
            // Preserve scroll position of checklist across re-render
            const gridEl = backdrop.querySelector('#lk-book-grid');
            const prevScroll = gridEl ? gridEl.scrollTop : 0;
            renderAll();
            const nextGridEl = backdrop.querySelector('#lk-book-grid');
            if (nextGridEl) nextGridEl.scrollTop = prevScroll;
            return;
        }

        if (t.id === 'lk-char-select') {
            const env = getLiveEnvData();
            handleCharPick(t.value, env);
            renderAll();
            return;
        }

        if (t.id === 'lk-char-preset-select') {
            state.selectedCharPreset = t.value;
            renderAll();
            return;
        }

        if (t.classList.contains('lk-toggle-input') && t.dataset.opt) {
            const optKey = t.dataset.opt;
            const s = loadSettings();
            s.options[optKey] = Boolean(t.checked);
            saveSettings(s);
            syncExtensionDrawerSummary();
            renderAll();
        }
    });

    // Live search inputs without losing focus / IME composition
    backdrop.addEventListener('input', (e) => {
        const t = e.target;
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
        if (t.id === 'lk-char-search') {
            state.charSearch = t.value;
            const pos = t.selectionStart;
            renderBody(getLiveEnvData());
            const nextInput = backdrop.querySelector('#lk-char-search');
            if (nextInput) {
                nextInput.focus();
                if (typeof pos === 'number') nextInput.setSelectionRange(pos, pos);
            }
        }
    });

    document.addEventListener('keydown', onKeyDown);
    document.body.appendChild(backdrop);
    unbindVp = bindViewportPin(backdrop);
    renderAll();

    setOnStateChangedCallback(() => {
        if (backdrop.isConnected && !isAnyDirty()) {
            renderAll();
        } else if (backdrop.isConnected) {
            renderStatusBar(getLiveEnvData());
        }
    });

    activeModal = {
        focusPanel: () => backdrop.querySelector('.lk-modal')?.focus?.(),
    };
}

/**
 * Updates the summary text & quick toggle inside SillyTavern's Extensions Settings drawer if mounted.
 */
export function syncExtensionDrawerSummary() {
    const s = loadSettings();
    const summaryEl = document.getElementById('lk-drawer-summary');
    if (summaryEl) {
        const gCount = s.bindingGroups.length;
        const cCount = Object.keys(s.characterPresetBindings).length;
        summaryEl.textContent = `已保存 ${gCount} 组预设世界书绑定 · ${cCount} 个角色预设绑定`;
    }
    const autoChk = document.getElementById('lk-drawer-auto-update');
    if (autoChk) {
        autoChk.checked = Boolean(s.options.autoBindPresetUpdate);
    }
}

/**
 * Mounts entry points in both `#extensionsMenu` (magic wand menu) and `#extensions_settings2` (Extensions tab).
 */
export function mountExtensionEntries() {
    // 1. Magic wand menu (`#extensionsMenu`)
    const extMenu = document.getElementById('extensionsMenu');
    if (extMenu && !document.getElementById('preset-binder-menu-item')) {
        const item = document.createElement('div');
        item.id = 'preset-binder-menu-item';
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.innerHTML = `
            <span class="fa-solid fa-fw fa-link"></span>
            <span>${esc(EXTENSION_DISPLAY_NAME)}</span>
        `;
        item.addEventListener('click', () => showSettingsPanel('preset-lorebook'));
        extMenu.appendChild(item);
    }

    // 2. Extensions settings drawer (`#extensions_settings2` / `#extensions_settings`)
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
