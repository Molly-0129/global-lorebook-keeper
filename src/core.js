// Core runtime logic: preset switching, smart version detection, worldbook sync & character preset switching

import { isSwitchingChatPreset, readChatBinding, switchChatPreset } from './chat.js';
import { promptPresetUpdateDetected } from './dialog.js';
import { findPresetUpdateMatch } from './matcher.js';
import {
    getActivePresetManager,
    getCurrentPresetName,
    getSelectedWorldInfo,
    getWorldNames,
} from './st-env.js';
import {
    attachPresetToGroup,
    findGroupByPreset,
    getLorebooksForPreset,
    loadSettings,
    saveSettings,
    uniqueStrings,
} from './storage.js';

const lastPresetForApi = {};
let lastImportTimestamp = 0;
let activeUpdatePromptPreset = null;
let onStateChangedCallback = null;

export function setOnStateChangedCallback(fn) {
    onStateChangedCallback = fn;
}

function notifyPanelRefresh() {
    if (typeof onStateChangedCallback === 'function') {
        try {
            onStateChangedCallback();
        } catch (err) {
            console.warn('[LorebookKeeper] Panel refresh callback failed:', err);
        }
    }
}

export function markPresetImportActivity() {
    lastImportTimestamp = Date.now();
}

export function snapshotInitialPresets() {
    $('select[data-preset-manager-for]').each(function () {
        const rawFor = String($(this).data('preset-manager-for') || '');
        const selectedText = $(this).find('option:selected').text().trim();
        for (const apiId of rawFor.split(',')) {
            if (apiId) lastPresetForApi[apiId.trim()] = selectedText;
        }
    });
}

/**
 * Applies global lorebook activation/deactivation safely and warns about missing lorebooks.
 * @returns {{ changed: boolean, activatedValid: string[], missingBooks: string[] }}
 */
export function applyGlobalLorebookDiff(worldsToDeactivate = [], worldsToActivate = [], {
    presetLabel = '',
    showToast = true,
    customToast = '',
} = {}) {
    const selectedWorldInfo = getSelectedWorldInfo();
    const worldNames = getWorldNames();
    const activateList = uniqueStrings(worldsToActivate);
    const deactivateList = uniqueStrings(worldsToDeactivate);

    const missingBooks = [];
    const activatedValid = [];
    for (const book of activateList) {
        if (worldNames.includes(book)) {
            activatedValid.push(book);
        } else {
            missingBooks.push(book);
        }
    }

    const nextWorlds = new Set(selectedWorldInfo);
    for (const book of deactivateList) {
        if (!activatedValid.includes(book)) {
            nextWorlds.delete(book);
        }
    }
    for (const book of activatedValid) {
        nextWorlds.add(book);
    }

    const finalNames = Array.from(nextWorlds);
    const prevSorted = JSON.stringify([...selectedWorldInfo].sort());
    const nextSorted = JSON.stringify([...finalNames].sort());
    const changed = prevSorted !== nextSorted;

    if (changed) {
        const finalIndices = finalNames
            .map(name => worldNames.indexOf(name))
            .filter(idx => idx !== -1)
            .map(idx => String(idx));

        selectedWorldInfo.splice(0, selectedWorldInfo.length, ...finalNames);
        $('#world_info').val(finalIndices).trigger('change');
    }

    if (missingBooks.length > 0) {
        const prefix = presetLabel ? `预设「${presetLabel}」` : '当前绑定';
        toastr.warning(
            `${prefix}关联的世界书未找到：${missingBooks.join('、')}（可能已被删除或重命名）`,
            '世界书绑定提醒',
        );
    }

    if (showToast) {
        if (customToast) {
            toastr.success(customToast);
        } else if (changed) {
            if (activatedValid.length > 0) {
                toastr.success(`已按预设「${presetLabel}」同步全局世界书（启用 ${activatedValid.length} 本）`);
            } else if (deactivateList.length > 0) {
                toastr.info('已切出绑定预设，自动关闭原绑定世界书');
            }
        }
    }

    notifyPanelRefresh();
    return { changed, activatedValid, missingBooks };
}

export function syncActivePresetImmediately({ showToast = false, customToast = '' } = {}) {
    const preset = getCurrentPresetName();
    const settings = loadSettings();
    const wanted = uniqueStrings([...getLorebooksForPreset(settings, preset), ...(readChatBinding().lorebooks || [])]);
    const selected = new Set(getSelectedWorldInfo());
    const available = new Set(getWorldNames());
    const owned = settings.appliedLorebooks || [];
    if (!available.size) {
        notifyPanelRefresh();
        return { changed: false, activatedValid: [], missingBooks: [] };
    }
    const nextOwned = wanted.filter(book => available.has(book) && (owned.includes(book) || !selected.has(book)));
    const ownershipChanged = owned.length !== nextOwned.length || owned.some(book => !nextOwned.includes(book));
    if (ownershipChanged) {
        settings.appliedLorebooks = nextOwned;
        saveSettings(settings);
    }
    return applyGlobalLorebookDiff(owned, wanted, { presetLabel: preset, showToast, customToast });
}

export function applyCurrentChatBinding() {
    return switchChatPreset(() => syncActivePresetImmediately({ showToast: loadSettings().options.notifyOnSwitch }));
}

/** Handles manual preset changes and detects updated versions of presets. */
export async function handlePresetSelectChange(event) {
    const selectElement = event.currentTarget || event.target;
    const apiIds = String($(selectElement).data('preset-manager-for') || '').split(',').map(id => id.trim());
    const apiId = getActivePresetManager()?.apiId;
    if (!apiId || !apiIds.includes(apiId)) return;
    const preset = $(selectElement).find('option:selected').text().trim();
    if (!preset) return;

    const previous = lastPresetForApi[apiId];
    lastPresetForApi[apiId] = preset;
    if (isSwitchingChatPreset()) return;

    const settings = loadSettings();
    const imported = Date.now() - lastImportTimestamp < 6000;
    if (preset !== previous || imported) {
        if (imported) lastImportTimestamp = 0;
        const match = !findGroupByPreset(settings, preset) && findPresetUpdateMatch(preset, settings.bindingGroups);
        if (match && settings.options.autoBindPresetUpdate) {
            attachPresetToGroup(match.group.id, preset);
        } else if (match && settings.options.promptOnPresetUpdate !== false
            && !settings.ignoredUpdatePresets.includes(preset) && !activeUpdatePromptPreset) {
            activeUpdatePromptPreset = preset;
            try {
                const decision = await promptPresetUpdateDetected({
                    newPresetName: preset,
                    matchedPreset: match.matchedPreset,
                    groupName: match.group.name,
                    lorebooks: match.group.lorebooks,
                    availableWorldNames: getWorldNames(),
                });
                if (decision.action === 'bind') attachPresetToGroup(match.group.id, preset);
                if (decision.action === 'ignore') {
                    const fresh = loadSettings();
                    if (!fresh.ignoredUpdatePresets.includes(preset)) {
                        fresh.ignoredUpdatePresets.push(preset);
                        saveSettings(fresh);
                    }
                }
            } finally {
                activeUpdatePromptPreset = null;
            }
        }
    }
    syncActivePresetImmediately({ showToast: settings.options.notifyOnSwitch });
}

/**
 * Keeps bindings synchronized when a user renames a preset inside SillyTavern.
 */
export function handlePresetRenamed(payload) {
    const oldName = String(payload?.oldName || '').trim();
    const newName = String(payload?.newName || '').trim();
    if (!oldName || !newName || oldName === newName) return;

    const settings = loadSettings();
    let updatedGroups = 0;

    for (const grp of settings.bindingGroups) {
        const idx = grp.presets.indexOf(oldName);
        if (idx !== -1) {
            grp.presets[idx] = newName;
            grp.presets = uniqueStrings(grp.presets);
            grp.updatedAt = Date.now();
            updatedGroups++;
        }
    }

    for (const key of Object.keys(lastPresetForApi)) {
        if (lastPresetForApi[key] === oldName) {
            lastPresetForApi[key] = newName;
        }
    }

    let updatedRole = false;
    for (const [avatar, binding] of Object.entries(settings.characterPresetBindings)) {
        if (binding === oldName) {
            settings.characterPresetBindings[avatar] = newName;
            updatedRole = true;
        } else if (binding?.preset === oldName && (!payload.apiId || payload.apiId === binding.apiId)) {
            settings.characterPresetBindings[avatar] = { ...binding, preset: newName };
            updatedRole = true;
        }
    }
    if (updatedGroups > 0 || updatedRole) {
        saveSettings(settings);
        toastr.info(`预设已重命名为「${newName}」，绑定关系已自动同步`);
        notifyPanelRefresh();
    }
}


export function handleCharacterRenamed(oldAvatar, newAvatar) {
    if (!oldAvatar || !newAvatar || oldAvatar === newAvatar) return;
    const settings = loadSettings();
    if (!Object.hasOwn(settings.characterPresetBindings, oldAvatar)) return;
    settings.characterPresetBindings[newAvatar] ??= settings.characterPresetBindings[oldAvatar];
    delete settings.characterPresetBindings[oldAvatar];
    saveSettings(settings);
    notifyPanelRefresh();
}
