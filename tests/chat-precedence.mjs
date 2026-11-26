import test from 'node:test';
import assert from 'node:assert/strict';
import { registerStEnv } from '../src/st-env.js';
import { loadSettings, saveSettings } from '../src/storage.js';
import { currentChat, installPromptOverrides, listPresetPrompts, saveChatBinding, switchChatPreset } from '../src/chat.js';

test('role defaults, chat exceptions and manual mode share one preset switch', async () => {
    const chats = {
        ordinary: {},
        inherited: { globalLorebookKeeper: { mode: 'inherit', apiId: 'openai', preset: 'Story', prompts: { voice: true } } },
        explicit: { globalLorebookKeeper: { apiId: 'openai', preset: 'Diary' } },
        legacyManual: { globalLorebookKeeper: { preset: '', lorebooks: ['School'] } },
    };
    let chatId = 'ordinary';
    let groupId;
    let selected = 'Base';
    const selections = [];
    const pm = {
        apiId: 'openai',
        getSelectedPresetName: () => selected,
        findPreset: name => ['Story', 'Diary', 'Base'].includes(name) ? name : undefined,
        async selectPreset(name) { selected = name; selections.push(name); },
    };
    const ctx = () => ({
        chatId, chatMetadata: chats[chatId], groupId, characterId: 0, characters: [{ avatar: 'fox.png' }],
        saveSettingsDebounced() {}, async saveMetadata() {},
    });
    registerStEnv({ getContextFn: ctx, getPresetManagerFn: () => pm, extensionSettingsObj: {} });
    const settings = loadSettings();
    settings.characterPresetBindings['fox.png'] = 'Story';
    saveSettings(settings);
    const open = async (id, expected) => {
        chatId = id;
        const before = selections.length;
        await switchChatPreset(() => {});
        assert.equal(selected, expected);
        assert.ok(selections.length - before <= 1);
    };
    const manager = {
        getPromptOrderForCharacter: () => [{ identifier: 'voice', enabled: false }],
        getPromptCollection() { return this.getPromptOrderForCharacter().map(entry => entry.enabled); },
        isPromptDisabledForActiveCharacter() { return !this.getPromptCollection()[0]; },
    };
    installPromptOverrides(manager);
    await open('ordinary', 'Story');
    await open('explicit', 'Diary');
    await open('inherited', 'Story');
    assert.deepEqual(manager.getPromptCollection(), [true]);
    const changed = loadSettings();
    changed.characterPresetBindings['fox.png'] = { apiId: 'openai', preset: 'Diary' };
    saveSettings(changed);
    await open('inherited', 'Diary');
    assert.deepEqual(manager.getPromptCollection(), [false]);
    await open('legacyManual', 'Base');
    await open('ordinary', 'Diary');
    await saveChatBinding(currentChat(), { mode: 'manual' });
    await open('ordinary', 'Base');
    await saveChatBinding(currentChat(), {});
    await open('ordinary', 'Diary');
    groupId = 'group';
    await open('ordinary', 'Base');
    await open('explicit', 'Diary');
    groupId = undefined;
    pm.apiId = 'other';
    selected = 'Other API selection';
    await open('ordinary', 'Other API selection');
});

test('the binding panel follows the preset order, including disabled prompts', () => {
    const preset = {
        prompts: [
            { identifier: 'interrupt' },
            { identifier: 'unused' },
            { identifier: 'do-not-interrupt' },
        ],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'do-not-interrupt', enabled: false },
            { identifier: 'missing' },
            { identifier: 'interrupt', enabled: true },
        ] }],
    };
    const manager = { apiId: 'openai', getCompletionPresetByName: () => preset };
    assert.deepEqual(listPresetPrompts(manager, 'Story').map(prompt => prompt.identifier), [
        'do-not-interrupt',
        'interrupt',
    ]);
});
