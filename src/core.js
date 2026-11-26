// Core runtime logic: preset switching, smart version detection, worldbook sync & character preset switching

import { promptPresetUpdateDetected } from './dialog.js';
import { findPresetUpdateMatch } from './matcher.js';
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
    const ctx = getStContext();

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
        ctx?.saveSettingsDebounced?.();
        $('#world_info').val(finalIndices).trigger('change');
        if (ctx?.eventSource && ctx?.eventTypes?.WORLDINFO_SETTINGS_UPDATED) {
            ctx.eventSource.emit(ctx.eventTypes.WORLDINFO_SETTINGS_UPDATED);
        }
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

/**
 * Immediately synchronizes global lorebooks if the currently active preset is affected by an edit/save in the panel.
 */
export function syncActivePresetImmediately({ previousBooksForActivePreset = [] } = {}) {
    const activePreset = getCurrentPresetName();
    if (!activePreset) return { isActivePreset: false, changed: false, activatedValid: [], missingBooks: [] };

    const settings = loadSettings();
    const nextBooks = getLorebooksForPreset(settings, activePreset);
    const prevBooks = uniqueStrings(previousBooksForActivePreset);

    if (nextBooks.length === 0 && prevBooks.length === 0) {
        return { isActivePreset: false, changed: false, activatedValid: [], missingBooks: [] };
    }

    const res = applyGlobalLorebookDiff(prevBooks, nextBooks, {
        presetLabel: activePreset,
        showToast: false,
    });

    return {
        isActivePreset: true,
        ...res,
    };
}

/**
 * Returns character names bound to any preset in the given list.
 */
function getAffectedCharacterNames(settings, presetNames = []) {
    const ctx = getStContext();
    const chars = Array.isArray(ctx?.characters) ? ctx.characters : [];
    const targetSet = new Set(presetNames);
    const names = [];

    for (const [avatar, boundPreset] of Object.entries(settings.characterPresetBindings)) {
        if (targetSet.has(boundPreset)) {
            const c = chars.find(ch => ch?.avatar === avatar);
            names.push(c?.name || avatar);
        }
    }
    return names;
}

/**
 * Handles `<select data-preset-manager-for>` change events, including overwrite imports and version updates.
 */
export async function handlePresetSelectChange(event) {
    const selectElement = event.currentTarget || event.target;
    const rawFor = String($(selectElement).data('preset-manager-for') || '');
    const apiId = rawFor.split(',')[0]?.trim() || 'default';
    const newPresetName = $(selectElement).find('option:selected').text().trim();
    const oldPresetName = lastPresetForApi[apiId] ?? null;

    if (!newPresetName) return;

    const settings = loadSettings();
    const notify = settings.options.notifyOnSwitch !== false;

    // Same-name preset overwrite check (e.g. re-importing a preset with identical filename)
    if (newPresetName === oldPresetName) {
        const justImported = Date.now() - lastImportTimestamp < 6000;
        if (justImported) {
            const boundBooks = getLorebooksForPreset(settings, newPresetName);
            if (boundBooks.length > 0) {
                lastImportTimestamp = 0;
                applyGlobalLorebookDiff([], boundBooks, {
                    presetLabel: newPresetName,
                    showToast: true,
                    customToast: `检测到预设「${newPresetName}」覆盖更新，已确保 ${boundBooks.length} 本绑定世界书处于启用状态`,
                });
            }
        }
        return;
    }

    lastPresetForApi[apiId] = newPresetName;

    const oldBooks = getLorebooksForPreset(settings, oldPresetName);
    let newGroup = findGroupByPreset(settings, newPresetName);

    // If the newly selected preset has no binding, check if it is an updated version of a bound preset
    if (!newGroup) {
        const match = findPresetUpdateMatch(newPresetName, settings.bindingGroups);

        if (match) {
            // Mode 1: Auto-bind toggle is ON -> bind seamlessly without dropping lorebooks
            if (settings.options.autoBindPresetUpdate) {
                const attachRes = attachPresetToGroup(match.group.id, newPresetName, {
                    replaceOldPresetInChars: Boolean(settings.options.syncCharPresetOnUpdate),
                });
                newGroup = attachPresetToGroupResultGroup(attachRes, match.group);
                const charHint = attachRes.updatedCharCount > 0
                    ? `，并同步了 ${attachRes.updatedCharCount} 个角色的预设绑定`
                    : '';
                applyGlobalLorebookDiff(oldBooks, newGroup.lorebooks, {
                    presetLabel: newPresetName,
                    showToast: true,
                    customToast: `已识别新版预设「${newPresetName}」，自动继承「${match.matchedPreset}」的 ${newGroup.lorebooks.length} 本世界书绑定${charHint}`,
                });
                return;
            }

            // Mode 2: Auto-bind is OFF -> prompt user if enabled & not ignored
            const isIgnored = settings.ignoredUpdatePresets.includes(newPresetName);
            if (settings.options.promptOnPresetUpdate !== false && !isIgnored && activeUpdatePromptPreset !== newPresetName) {
                activeUpdatePromptPreset = newPresetName;
                try {
                    const affectedCharNames = getAffectedCharacterNames(settings, match.group.presets);
                    const decision = await promptPresetUpdateDetected({
                        newPresetName,
                        matchedPreset: match.matchedPreset,
                        lorebooks: match.group.lorebooks,
                        availableWorldNames: getWorldNames(),
                        affectedCharNames,
                        defaultSyncChars: Boolean(settings.options.syncCharPresetOnUpdate),
                    });

                    if (decision.action === 'bind') {
                        const attachRes = attachPresetToGroup(match.group.id, newPresetName, {
                            replaceOldPresetInChars: decision.syncChars,
                        });
                        const updatedGrp = attachPresetToGroupResultGroup(attachRes, match.group);
                        const charHint = attachRes.updatedCharCount > 0
                            ? `，同时更新了 ${attachRes.updatedCharCount} 个关联角色`
                            : '';
                        applyGlobalLorebookDiff(oldBooks, updatedGrp.lorebooks, {
                            presetLabel: newPresetName,
                            showToast: true,
                            customToast: `已将「${newPresetName}」加入绑定关系并启用 ${updatedGrp.lorebooks.length} 本世界书${charHint}`,
                        });
                        return;
                    }

                    if (decision.action === 'ignore') {
                        const fresh = loadSettings();
                        if (!fresh.ignoredUpdatePresets.includes(newPresetName)) {
                            fresh.ignoredUpdatePresets.push(newPresetName);
                            saveSettings(fresh);
                        }
                        toastr.info(`已忽略预设「${newPresetName}」的更新绑定提醒（可在面板设置中恢复）`);
                    }
                } finally {
                    activeUpdatePromptPreset = null;
                }
            }
        }
    }

    const newBooks = newGroup ? newGroup.lorebooks : [];
    applyGlobalLorebookDiff(oldBooks, newBooks, {
        presetLabel: newPresetName,
        showToast: notify,
    });
}

function attachPresetToGroupResultGroup(attachRes, fallbackGroup) {
    return attachRes?.group || fallbackGroup;
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
    let updatedChars = 0;

    for (const grp of settings.bindingGroups) {
        const idx = grp.presets.indexOf(oldName);
        if (idx !== -1) {
            grp.presets[idx] = newName;
            grp.presets = uniqueStrings(grp.presets);
            grp.updatedAt = Date.now();
            updatedGroups++;
        }
    }

    for (const [avatar, preset] of Object.entries(settings.characterPresetBindings)) {
        if (preset === oldName) {
            settings.characterPresetBindings[avatar] = newName;
            updatedChars++;
        }
    }

    for (const key of Object.keys(lastPresetForApi)) {
        if (lastPresetForApi[key] === oldName) {
            lastPresetForApi[key] = newName;
        }
    }

    if (updatedGroups > 0 || updatedChars > 0) {
        saveSettings(settings);
        toastr.info(`预设已重命名为「${newName}」，绑定关系已自动同步`);
        notifyPanelRefresh();
    }
}

/**
 * Keeps character-preset bindings synchronized if a character's avatar filename changes on rename.
 */
export function handleCharacterRenamed(oldAvatar, newAvatar) {
    const oldKey = String(oldAvatar || '').trim();
    const newKey = String(newAvatar || '').trim();
    if (!oldKey || !newKey || oldKey === newKey) return;

    const settings = loadSettings();
    if (settings.characterPresetBindings[oldKey]) {
        settings.characterPresetBindings[newKey] = settings.characterPresetBindings[oldKey];
        delete settings.characterPresetBindings[oldKey];
        saveSettings(settings);
        notifyPanelRefresh();
    }
}

/**
 * Automatically switches preset when entering a character chat with a bound preset.
 */
export function applyCharacterPreset() {
    const character = getCurrentCharacter();
    if (!character?.avatar) return;

    const settings = loadSettings();
    const boundPresetName = settings.characterPresetBindings[character.avatar];
    if (!boundPresetName) return;

    const presetManager = getActivePresetManager();
    if (!presetManager) return;

    const presetValue = presetManager.findPreset(boundPresetName);
    if (presetValue !== undefined && presetValue !== null) {
        if (presetManager.getSelectedPresetName() !== boundPresetName) {
            presetManager.selectPreset(presetValue);
            if (settings.options.notifyOnSwitch !== false) {
                toastr.success(`已为角色「${character.name}」自动切换预设：${boundPresetName}`);
            }
        }
    } else {
        // Check if there is a newer version of the missing preset in the preset list to give a helpful hint
        const allPresets = presetManager.getAllPresets?.() || [];
        const tempGroup = [{ id: '__char_probe__', presets: [boundPresetName], lorebooks: ['__probe__'] }];
        let hint = '';
        for (const p of allPresets) {
            if (findPresetUpdateMatch(p, tempGroup)) {
                hint = `（检测到近似新版「${p}」，可在绑定器中更新）`;
                break;
            }
        }
        toastr.warning(`角色「${character.name}」绑定的预设「${boundPresetName}」未找到${hint}`);
    }
}
