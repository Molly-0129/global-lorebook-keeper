// Storage & v1 -> v2 seamless data migration for Global Lorebook Keeper

import { getExtensionSettingsRoot, getStContext } from './st-env.js';

export const EXTENSION_DISPLAY_NAME = '角色-预设-世界书绑定器';
export const EXTENSION_STORAGE_NAME = '角色-预设-世界书绑定器';
export const EXTENSION_SETTINGS_KEY = 'presetBinderSettings';

export const RAINBOW_COLORS = [
    { key: 'red', label: '红', hex: '#ef4444' },
    { key: 'orange', label: '橙', hex: '#f97316' },
    { key: 'yellow', label: '黄', hex: '#eab308' },
    { key: 'green', label: '绿', hex: '#22c55e' },
    { key: 'cyan', label: '青', hex: '#06b6d4' },
    { key: 'blue', label: '蓝', hex: '#3b82f6' },
    { key: 'purple', label: '紫', hex: '#a855f7' },
];

const VALID_COLOR_KEYS = new Set(RAINBOW_COLORS.map(c => c.key));

export function getRainbowColorMeta(colorKey) {
    if (!colorKey) return null;
    return RAINBOW_COLORS.find(c => c.key === colorKey) || null;
}

function normalizeColorKey(rawColor) {
    const k = typeof rawColor === 'string' ? rawColor.trim().toLowerCase() : '';
    return VALID_COLOR_KEYS.has(k) ? k : '';
}

export const DEFAULT_OPTIONS = {
    autoBindPresetUpdate: false,   // 默认关闭自动绑定，由用户手动开启
    promptOnPresetUpdate: true,    // 默认开启新版预设识别弹窗提醒
    syncCharPresetOnUpdate: false, // 继承新版预设时是否默认同步更新角色绑定
    notifyOnSwitch: true,          // 切换预设/角色联动时显示右上角状态提醒
};

function makeGroupId() {
    return `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function uniqueStrings(arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const item of arr) {
        const s = typeof item === 'string' ? item.trim() : '';
        if (s && !seen.has(s)) {
            seen.add(s);
            out.push(s);
        }
    }
    return out;
}

/**
 * Loads and normalizes plugin settings, migrating v1 `presetLorebookBindings` seamlessly if needed.
 */
export function loadSettings() {
    const root = getExtensionSettingsRoot();
    if (!root[EXTENSION_STORAGE_NAME]) {
        root[EXTENSION_STORAGE_NAME] = {};
    }

    const raw = root[EXTENSION_STORAGE_NAME][EXTENSION_SETTINGS_KEY] ?? {};
    const options = {
        ...DEFAULT_OPTIONS,
        ...(raw.options && typeof raw.options === 'object' ? raw.options : {}),
    };

    const characterPresetBindings = {};
    if (raw.characterPresetBindings && typeof raw.characterPresetBindings === 'object') {
        for (const [avatar, preset] of Object.entries(raw.characterPresetBindings)) {
            if (avatar && typeof preset === 'string' && preset.trim()) {
                characterPresetBindings[avatar] = preset.trim();
            }
        }
    }

    const bindingGroups = [];
    let migrated = false;

    if (Array.isArray(raw.bindingGroups)) {
        const claimedPresets = new Set();
        for (const g of raw.bindingGroups) {
            if (!g || typeof g !== 'object') continue;
            const presets = uniqueStrings(g.presets).filter((p) => {
                if (claimedPresets.has(p)) return false;
                claimedPresets.add(p);
                return true;
            });
            const lorebooks = uniqueStrings(g.lorebooks);
            if (!presets.length || !lorebooks.length) continue;
            bindingGroups.push({
                id: typeof g.id === 'string' && g.id ? g.id : makeGroupId(),
                name: typeof g.name === 'string' ? g.name.trim() : '',
                color: normalizeColorKey(g.color),
                presets,
                lorebooks,
                updatedAt: Number(g.updatedAt) || Date.now(),
            });
        }
    } else if (!Object.hasOwn(raw, 'bindingGroups') && raw.presetLorebookBindings && typeof raw.presetLorebookBindings === 'object' && !Array.isArray(raw.presetLorebookBindings)) {
        migrated = true;
        for (const [preset, booksRaw] of Object.entries(raw.presetLorebookBindings)) {
            const presetName = String(preset || '').trim();
            const books = uniqueStrings(Array.isArray(booksRaw) ? booksRaw : [booksRaw]);
            if (!presetName || !books.length) continue;
            bindingGroups.push({
                id: makeGroupId(),
                name: '',
                color: '',
                presets: [presetName],
                lorebooks: books,
                updatedAt: Date.now(),
            });
        }
    }

    const ignoredUpdatePresets = uniqueStrings(raw.ignoredUpdatePresets);

    const normalized = {
        version: 2,
        options,
        bindingGroups,

        characterPresetBindings,
        ignoredUpdatePresets,
    };

    const malformedGroups = (Object.hasOwn(raw, 'bindingGroups') && !Array.isArray(raw.bindingGroups))
        || (Object.hasOwn(raw, 'presetLorebookBindings') && !Array.isArray(raw.bindingGroups)
            && (!raw.presetLorebookBindings || typeof raw.presetLorebookBindings !== 'object' || Array.isArray(raw.presetLorebookBindings)));
    if (!malformedGroups && (migrated || raw.version !== 2 || Object.hasOwn(raw, 'presetLorebookBindings'))) {
        root[EXTENSION_STORAGE_NAME][EXTENSION_SETTINGS_KEY] = normalized;
        getStContext()?.saveSettingsDebounced?.();
    }

    return normalized;
}

/**
 * Persists the canonical binding groups and plugin options.
 */
export function saveSettings(data) {
    const root = getExtensionSettingsRoot();
    if (!root[EXTENSION_STORAGE_NAME]) {
        root[EXTENSION_STORAGE_NAME] = {};
    }

    const claimedPresets = new Set();
    const cleanGroups = [];
    for (const g of Array.isArray(data.bindingGroups) ? data.bindingGroups : []) {
        const presets = uniqueStrings(g.presets).filter((p) => {
            if (claimedPresets.has(p)) return false;
            claimedPresets.add(p);
            return true;
        });
        const lorebooks = uniqueStrings(g.lorebooks);
        if (!presets.length || !lorebooks.length) continue;
        cleanGroups.push({
            id: g.id || makeGroupId(),
            name: typeof g.name === 'string' ? g.name.trim() : '',
            color: normalizeColorKey(g.color),
            presets,
            lorebooks,
            updatedAt: Number(g.updatedAt) || Date.now(),
        });
    }

    const payload = {
        version: 2,
        options: {
            ...DEFAULT_OPTIONS,
            ...(data.options || {}),
        },
        bindingGroups: cleanGroups,

        characterPresetBindings: { ...(data.characterPresetBindings || {}) },
        ignoredUpdatePresets: uniqueStrings(data.ignoredUpdatePresets),
    };

    root[EXTENSION_STORAGE_NAME][EXTENSION_SETTINGS_KEY] = payload;
    getStContext()?.saveSettingsDebounced?.();
    return payload;
}

export function findGroupByPreset(settings, presetName) {
    if (!presetName) return null;
    return settings.bindingGroups.find(g => g.presets.includes(presetName)) || null;
}

export function getLorebooksForPreset(settings, presetName) {
    const grp = findGroupByPreset(settings, presetName);
    return grp ? [...grp.lorebooks] : [];
}

export function upsertBindingGroup({ groupId = null, name = '', color = '', presets = [], lorebooks = [] }) {
    const settings = loadSettings();
    const cleanPresets = uniqueStrings(presets);
    const cleanLorebooks = uniqueStrings(lorebooks);
    const cleanName = String(name || '').trim();
    const cleanColor = normalizeColorKey(color);
    const movedPresets = [];

    const remainingGroups = [];
    let targetGroup = null;

    for (const grp of settings.bindingGroups) {
        if (groupId && grp.id === groupId) {
            targetGroup = grp;
            remainingGroups.push(grp);
            continue;
        }
        const overlap = grp.presets.filter(p => cleanPresets.includes(p));
        if (overlap.length > 0) {
            movedPresets.push(...overlap);
            const filtered = grp.presets.filter(p => !cleanPresets.includes(p));
            if (filtered.length > 0) {
                remainingGroups.push({
                    ...grp,
                    presets: filtered,
                    updatedAt: Date.now(),
                });
            }
        } else {
            remainingGroups.push(grp);
        }
    }

    let savedGroup;
    if (targetGroup) {
        targetGroup.name = cleanName;
        targetGroup.color = cleanColor;
        targetGroup.presets = cleanPresets;
        targetGroup.lorebooks = cleanLorebooks;
        targetGroup.updatedAt = Date.now();
        savedGroup = targetGroup;
    } else {
        savedGroup = {
            id: makeGroupId(),
            name: cleanName,
            color: cleanColor,
            presets: cleanPresets,
            lorebooks: cleanLorebooks,
            updatedAt: Date.now(),
        };
        remainingGroups.unshift(savedGroup);
    }

    settings.bindingGroups = remainingGroups;
    settings.ignoredUpdatePresets = settings.ignoredUpdatePresets.filter(p => !cleanPresets.includes(p));

    const next = saveSettings(settings);
    return {
        settings: next,
        group: next.bindingGroups.find(g => g.id === savedGroup.id) || savedGroup,
        movedPresets: uniqueStrings(movedPresets),
    };
}

export function attachPresetToGroup(groupId, newPresetName, { replaceOldPresetInChars = false } = {}) {
    const settings = loadSettings();
    const grp = settings.bindingGroups.find(g => g.id === groupId);
    if (!grp || !newPresetName) return { updated: false, updatedCharCount: 0, settings };

    const oldPresetsSnapshot = [...grp.presets];
    if (!grp.presets.includes(newPresetName)) {
        grp.presets.push(newPresetName);
        grp.updatedAt = Date.now();
    }

    let updatedCharCount = 0;
    if (replaceOldPresetInChars) {
        for (const [avatar, boundPreset] of Object.entries(settings.characterPresetBindings)) {
            if (oldPresetsSnapshot.includes(boundPreset) && boundPreset !== newPresetName) {
                settings.characterPresetBindings[avatar] = newPresetName;
                updatedCharCount++;
            }
        }
    }

    settings.ignoredUpdatePresets = settings.ignoredUpdatePresets.filter(p => p !== newPresetName);
    const next = saveSettings(settings);
    return {
        updated: true,
        updatedCharCount,
        group: next.bindingGroups.find(g => g.id === groupId) || grp,
        settings: next,
    };
}

export function deleteBindingGroup(groupId) {
    const settings = loadSettings();
    const target = settings.bindingGroups.find(g => g.id === groupId) || null;
    settings.bindingGroups = settings.bindingGroups.filter(g => g.id !== groupId);
    const next = saveSettings(settings);
    return { removedGroup: target, settings: next };
}
