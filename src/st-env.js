// Runtime environment bridge for SillyTavern globals & ES module imports

let stBindings = {
    getContextFn: () => window.SillyTavern?.getContext?.() ?? null,
    extensionSettingsObj: null,
    getPresetManagerFn: () => null,
    getWorldNamesFn: () => [],
    getSelectedWorldInfoFn: () => [],
    getWorldInfoFn: () => ({}),
    loadWorldInfoFn: async () => null,
};

export function registerStEnv(bindings) {
    stBindings = { ...stBindings, ...bindings };
}

export function getStContext() {
    return stBindings.getContextFn?.() ?? window.SillyTavern?.getContext?.() ?? null;
}

export function getExtensionSettingsRoot() {
    if (stBindings.extensionSettingsObj) return stBindings.extensionSettingsObj;
    return getStContext()?.extensionSettings ?? {};
}

export function getActivePresetManager(apiId = '') {
    const pm = stBindings.getPresetManagerFn?.(apiId);
    if (pm) return pm;
    return getStContext()?.getPresetManager?.(apiId) ?? null;
}

export function getWorldNames() {
    const names = stBindings.getWorldNamesFn?.();
    return Array.isArray(names) ? names : [];
}

export function getSelectedWorldInfo() {
    const selected = stBindings.getSelectedWorldInfoFn?.();
    return Array.isArray(selected) ? selected : [];
}

export function getWorldInfoSettings() {
    const wi = stBindings.getWorldInfoFn?.();
    return wi && typeof wi === 'object' ? wi : {};
}

export async function loadWorldInfoData(name) {
    if (!name) return null;
    if (typeof stBindings.loadWorldInfoFn === 'function') {
        const res = await stBindings.loadWorldInfoFn(name);
        if (res) return res;
    }
    const ctx = getStContext();
    if (typeof ctx?.loadWorldInfo === 'function') {
        return await ctx.loadWorldInfo(name);
    }
    return null;
}

/**
 * Safely returns the currently active character object (null in group chats or when no chat is open).
 */
export function getCurrentCharacter() {
    const ctx = getStContext();
    if (!ctx || ctx.groupId) return null;

    if (ctx.characterId !== undefined && ctx.characterId !== null && ctx.characters?.[ctx.characterId]) {
        return ctx.characters[ctx.characterId];
    }

    const chatId = ctx.getCurrentChatId?.();
    if (!chatId || !Array.isArray(ctx.characters)) return null;
    return ctx.characters.find(c => c?.chat === chatId) ?? null;
}

/**
 * Returns the currently selected preset name for the active API.
 */
export function getCurrentPresetName() {
    const pm = getActivePresetManager();
    if (!pm) return '';
    return String(pm.getSelectedPresetName?.() ?? '').trim();
}
