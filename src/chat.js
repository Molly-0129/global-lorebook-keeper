import { getActivePresetManager, getCurrentCharacter, getStContext } from './st-env.js';
import { loadSettings, saveSettings, uniqueStrings } from './storage.js';

const metadataKey = 'globalLorebookKeeper';
let pendingSwitch = Promise.resolve();
let switchRevision = 0;
let switchingPreset = false;
const patchedManagers = new WeakSet();

export function currentChat() {
    const ctx = getStContext();
    if (!ctx?.chatId || !ctx.chatMetadata) return null;
    const avatar = ctx.groupId ? undefined : getCurrentCharacter()?.avatar;
    if (ctx.groupId == null && !avatar) return null;
    const owner = ctx.groupId != null ? ['group', ctx.groupId] : ['character', avatar];
    return { ctx, key: JSON.stringify([...owner, ctx.chatId]), name: String(ctx.chatId) };
}

function normalizeEntryOverrides(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [worldName, map] of Object.entries(raw)) {
        const cleanWorld = String(worldName || '').trim();
        if (!cleanWorld || !map || typeof map !== 'object' || Array.isArray(map)) continue;
        const entries = {};
        for (const [uid, disabled] of Object.entries(map)) {
            if (typeof disabled === 'boolean') entries[String(uid)] = disabled;
        }
        if (Object.keys(entries).length > 0) out[cleanWorld] = entries;
    }
    return out;
}

export function readChatBinding(chat = currentChat()) {
    const binding = chat?.ctx.chatMetadata[metadataKey];
    if (!binding || typeof binding !== 'object') return {};
    const entryOverrides = normalizeEntryOverrides(binding.entryOverrides);
    const hasCore = Boolean(binding.mode || binding.preset || binding.lorebooks?.length || Object.keys(binding.prompts || {}).length);
    return {
        ...(hasCore ? {
            mode: binding.mode || (binding.preset ? 'preset' : 'manual'),
            apiId: typeof binding.apiId === 'string' ? binding.apiId : '',
            preset: typeof binding.preset === 'string' ? binding.preset : '',
            prompts: Object.fromEntries(Object.entries(binding.prompts || {}).filter(([, value]) => typeof value === 'boolean')),
            lorebooks: uniqueStrings(binding.lorebooks),
        } : {
            mode: '',
            apiId: '',
            preset: '',
            prompts: {},
            lorebooks: [],
        }),
        ...(Object.keys(entryOverrides).length ? { entryOverrides } : {}),
    };
}

export async function saveChatBinding(chat, binding) {
    const active = currentChat();
    if (!active || active.key !== chat?.key) throw new Error('聊天已切换，请打开目标聊天后再保存。');
    const { ctx } = active;
    if (typeof ctx.saveMetadata !== 'function') throw new Error('当前宿主不支持保存聊天元数据。');
    const metadata = ctx.chatMetadata;
    const previous = metadata[metadataKey];
    const entryOverrides = normalizeEntryOverrides(binding?.entryOverrides);
    const hasEntryOverrides = Object.keys(entryOverrides).length > 0;
    const cleaned = binding ? { ...binding } : {};
    if (hasEntryOverrides) cleaned.entryOverrides = entryOverrides;
    else delete cleaned.entryOverrides;
    const next = cleaned.mode === 'manual' || cleaned.preset || cleaned.lorebooks?.length || hasEntryOverrides ? cleaned : undefined;
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

/**
 * Sets or clears a per-chat disable override for a single lorebook entry.
 * `disabledOrNull === null` removes the override and restores the lorebook's default state.
 */
export async function saveChatEntryOverride(chat, worldName, uid, disabledOrNull) {
    const active = chat || currentChat();
    if (!active) throw new Error('当前未打开有效聊天窗口。');
    const current = readChatBinding(active);
    const nextOverrides = normalizeEntryOverrides(current.entryOverrides);
    const bookKey = String(worldName || '').trim();
    const uidKey = String(uid);
    if (!bookKey) return;

    if (disabledOrNull === null || disabledOrNull === undefined) {
        if (nextOverrides[bookKey]) {
            delete nextOverrides[bookKey][uidKey];
            if (!Object.keys(nextOverrides[bookKey]).length) delete nextOverrides[bookKey];
        }
    } else {
        nextOverrides[bookKey] = { ...(nextOverrides[bookKey] || {}), [uidKey]: Boolean(disabledOrNull) };
    }

    await saveChatBinding(active, { ...current, entryOverrides: nextOverrides });
}

/**
 * Clears all per-chat entry overrides for a specific lorebook in the current chat.
 */
export async function resetChatBookEntryOverrides(chat, worldName) {
    const active = chat || currentChat();
    if (!active) return;
    const current = readChatBinding(active);
    const nextOverrides = normalizeEntryOverrides(current.entryOverrides);
    if (!nextOverrides[worldName]) return;
    delete nextOverrides[worldName];
    await saveChatBinding(active, { ...current, entryOverrides: nextOverrides });
}

/**
 * Unbinds a single lorebook that was bound to the current chat via Global Lorebook Keeper.
 */
export async function unbindChatLorebook(chat, worldName) {
    const active = chat || currentChat();
    if (!active) throw new Error('当前未打开有效聊天窗口。');
    const current = readChatBinding(active);
    const nextLorebooks = uniqueStrings(current.lorebooks).filter(b => b !== worldName);
    await saveChatBinding(active, { ...current, lorebooks: nextLorebooks });
}

/**
 * Applies per-chat lorebook entry disable overrides inside SillyTavern's WORLDINFO_ENTRIES_LOADED hook.
 * Only mutates the in-memory scan objects for the current chat without touching global lorebook files.
 */
export function applyChatEntryOverrides(payload) {
    const overrides = readChatBinding().entryOverrides;
    if (!overrides || !Object.keys(overrides).length) return;
    for (const list of [payload?.globalLore, payload?.characterLore, payload?.chatLore, payload?.personaLore]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            const bookMap = entry?.world ? overrides[entry.world] : null;
            if (!bookMap) continue;
            const uidKey = String(entry.uid);
            if (Object.hasOwn(bookMap, uidKey)) {
                entry.disable = Boolean(bookMap[uidKey]);
            }
        }
    }
}

export function resolvePreset(binding, apiId, settings = loadSettings()) {
    if (binding.mode === 'manual') return '';
    if (binding.mode === 'preset' || (!binding.mode && binding.preset)) {
        return binding.apiId === apiId ? binding.preset : '';
    }
    const avatar = currentChat() && getCurrentCharacter()?.avatar;
    const role = avatar && settings.characterPresetBindings[avatar];
    if (typeof role === 'string') return role;
    return role && role.apiId === apiId ? role.preset : '';
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
            const settings = loadSettings();
            const bound = resolvePreset(binding, apiId, settings);
            const value = bound ? pm.findPreset(bound) : undefined;
            const baselines = { ...settings.presetBeforeChat };
            let nextPreset = '';
            if (bound && value != null) {
                if (selected && !Object.hasOwn(baselines, apiId)) {
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
    const promptsById = new Map(prompts.map(prompt => [prompt.identifier, prompt]));
    return order.flatMap(entry => {
        const prompt = promptsById.get(entry.identifier);
        return prompt ? [{ ...prompt, enabled: Boolean(entry.enabled) }] : [];
    });
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
                || binding.preset !== pm.getSelectedPresetName() || !Object.keys(binding.prompts || {}).length
                || resolvePreset(binding, pm.apiId) !== binding.preset) {
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
