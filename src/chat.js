import { getActivePresetManager, getStContext } from './st-env.js';
import { loadSettings, saveSettings, uniqueStrings } from './storage.js';

const metadataKey = 'globalLorebookKeeper';
let pendingSwitch = Promise.resolve();
let switchRevision = 0;
let switchingPreset = false;
const patchedManagers = new WeakSet();

export function currentChat() {
    const ctx = getStContext();
    if (!ctx?.chatId || !ctx.chatMetadata) return null;
    const owner = ctx.groupId ? ['group', ctx.groupId] : ['character', ctx.characters?.[ctx.characterId]?.avatar];
    return { ctx, key: JSON.stringify([...owner, ctx.chatId]), name: String(ctx.chatId) };
}

export function readChatBinding(chat = currentChat()) {
    const binding = chat?.ctx.chatMetadata[metadataKey];
    if (!binding || typeof binding !== 'object') return {};
    return {
        apiId: typeof binding.apiId === 'string' ? binding.apiId : '',
        preset: typeof binding.preset === 'string' ? binding.preset : '',
        prompts: Object.fromEntries(Object.entries(binding.prompts || {}).filter(([, value]) => typeof value === 'boolean')),
        lorebooks: uniqueStrings(binding.lorebooks),
    };
}

export async function saveChatBinding(chat, binding) {
    const active = currentChat();
    if (!active || active.key !== chat?.key) throw new Error('聊天已切换，请打开目标聊天后再保存。');
    const { ctx } = active;
    if (typeof ctx.saveMetadata !== 'function') throw new Error('当前宿主不支持保存聊天元数据。');
    const metadata = ctx.chatMetadata;
    const previous = metadata[metadataKey];
    const next = binding?.preset || binding?.lorebooks?.length ? binding : undefined;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    if (next) metadata[metadataKey] = next;
    else delete metadata[metadataKey];

    try {
        await ctx.saveMetadata();
    } catch (error) {
        if (previous === undefined) delete metadata[metadataKey];
        else metadata[metadataKey] = previous;
        throw error;
    }
}

export function isSwitchingChatPreset() {
    return switchingPreset;
}

export function switchChatPreset(onApplied) {
    const revision = ++switchRevision;
    const target = currentChat();
    pendingSwitch = pendingSwitch.catch(() => {}).then(async () => {
        if (revision !== switchRevision || currentChat()?.key !== target?.key) return;
        const pm = getActivePresetManager();
        const binding = readChatBinding();
        if (pm) {
            const apiId = pm.apiId;
            const selected = pm.getSelectedPresetName();
            const bound = binding.apiId === apiId ? binding.preset : '';
            const value = bound ? pm.findPreset(bound) : undefined;
            const settings = loadSettings();
            const baselines = { ...settings.presetBeforeChat };
            let nextPreset = '';
            if (bound && value != null) {
                if (selected && selected !== bound && !Object.hasOwn(baselines, apiId)) {
                    baselines[apiId] = selected;
                    settings.presetBeforeChat = baselines;
                    saveSettings(settings);
                }
                nextPreset = bound;
            } else {
                nextPreset = baselines[apiId] || '';
                if (bound) toastr.warning(`聊天绑定的预设「${bound}」已找不到，请在绑定面板重新选择。`);
            }
            const nextValue = nextPreset && pm.findPreset(nextPreset);
            if (nextPreset && nextValue != null && nextPreset !== selected) {
                switchingPreset = true;
                try {
                    await pm.selectPreset(nextValue);
                } finally {
                    switchingPreset = false;
                }
            }
            if ((!bound || value == null) && Object.hasOwn(baselines, apiId)) {
                const fresh = loadSettings();
                if (fresh.presetBeforeChat) delete fresh.presetBeforeChat[apiId];
                saveSettings(fresh);
            }
        }
        if (revision === switchRevision && currentChat()?.key === target?.key) onApplied();
    });
    return pendingSwitch;
}

export function listPresetPrompts(pm, preset) {
    if (pm?.apiId !== 'openai' || !preset) return [];
    const configuration = pm.getCompletionPresetByName?.(preset);
    const prompts = Array.isArray(configuration?.prompts) ? configuration.prompts : [];
    const order = configuration?.prompt_order?.find(list => String(list.character_id) === '100001')?.order;
    if (!Array.isArray(order)) return [];
    const identifiers = new Set(order.map(entry => entry.identifier));
    return prompts.filter(prompt => typeof prompt.identifier === 'string' && identifiers.has(prompt.identifier));
}

export function installPromptOverrides(manager) {
    if (!manager || patchedManagers.has(manager)) return;
    if (typeof manager.getPromptCollection !== 'function' || typeof manager.getPromptOrderForCharacter !== 'function'
        || typeof manager.isPromptDisabledForActiveCharacter !== 'function') return;

    const getOrder = manager.getPromptOrderForCharacter;
    for (const method of ['getPromptCollection', 'isPromptDisabledForActiveCharacter']) {
        const original = manager[method];
        manager[method] = function (...args) {
            const binding = readChatBinding();
            const pm = getActivePresetManager();
            if (pm?.apiId !== 'openai' || binding.apiId !== pm.apiId
                || binding.preset !== pm.getSelectedPresetName() || !Object.keys(binding.prompts).length) {
                return original.apply(this, args);
            }

            const previousOrder = this.getPromptOrderForCharacter;
            const ownOrder = Object.hasOwn(this, 'getPromptOrderForCharacter');
            this.getPromptOrderForCharacter = function (character) {
                return getOrder.call(this, character).map(entry => Object.hasOwn(binding.prompts, entry.identifier)
                    ? { ...entry, enabled: binding.prompts[entry.identifier] }
                    : entry);
            };
            try {
                return original.apply(this, args);
            } finally {
                if (ownOrder) this.getPromptOrderForCharacter = previousOrder;
                else delete this.getPromptOrderForCharacter;
            }
        };
    }
    patchedManagers.add(manager);
}
